-- ============================================================
-- MIGRATION: 20260904_production_transaction_safety.sql
-- Production Transaction Safety, Atomic Edits, Returns & Timeout Recovery
-- Non-destructive forward-only migration for live ERP / Accounting DB.
-- ============================================================

-- 1. Ensure request_id exists on return tables if any
ALTER TABLE IF EXISTS busy_ufo_sales_returns ADD COLUMN IF NOT EXISTS request_id VARCHAR(100);
ALTER TABLE IF EXISTS busy_ufo_purchase_returns ADD COLUMN IF NOT EXISTS request_id VARCHAR(100);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_returns_request_id ON busy_ufo_sales_returns(request_id) WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_returns_request_id ON busy_ufo_purchase_returns(request_id) WHERE request_id IS NOT NULL;

-- 2. Timeout Recovery Helper: Check transaction existence by request_id across tables
CREATE OR REPLACE FUNCTION get_transaction_by_request_id(p_request_id VARCHAR)
RETURNS JSONB AS $$
DECLARE
    v_rec RECORD;
BEGIN
    IF p_request_id IS NULL OR p_request_id = '' THEN
        RETURN jsonb_build_object('found', false);
    END IF;

    -- Check Sales
    SELECT id, invoice_number AS doc_number, 'SALE' AS doc_type, grand_total AS total, company_id 
    INTO v_rec FROM busy_ufo_sales WHERE request_id = p_request_id LIMIT 1;
    IF FOUND THEN
        RETURN jsonb_build_object('found', true, 'doc_type', 'SALE', 'id', v_rec.id, 'doc_number', v_rec.doc_number, 'company_id', v_rec.company_id);
    END IF;

    -- Check Purchases
    SELECT id, purchase_number AS doc_number, 'PURCHASE' AS doc_type, grand_total AS total, company_id 
    INTO v_rec FROM busy_ufo_purchases WHERE request_id = p_request_id LIMIT 1;
    IF FOUND THEN
        RETURN jsonb_build_object('found', true, 'doc_type', 'PURCHASE', 'id', v_rec.id, 'doc_number', v_rec.doc_number, 'company_id', v_rec.company_id);
    END IF;

    -- Check Receipts
    SELECT id, receipt_number AS doc_number, 'RECEIPT' AS doc_type, amount AS total, company_id 
    INTO v_rec FROM busy_ufo_customer_receipts WHERE request_id = p_request_id LIMIT 1;
    IF FOUND THEN
        RETURN jsonb_build_object('found', true, 'doc_type', 'RECEIPT', 'id', v_rec.id, 'doc_number', v_rec.doc_number, 'company_id', v_rec.company_id);
    END IF;

    -- Check Payments
    SELECT id, payment_number AS doc_number, 'PAYMENT' AS doc_type, amount AS total, company_id 
    INTO v_rec FROM busy_ufo_supplier_payments WHERE request_id = p_request_id LIMIT 1;
    IF FOUND THEN
        RETURN jsonb_build_object('found', true, 'doc_type', 'PAYMENT', 'id', v_rec.id, 'doc_number', v_rec.doc_number, 'company_id', v_rec.company_id);
    END IF;

    -- Check Expenses
    SELECT id, expense_number AS doc_number, 'EXPENSE' AS doc_type, amount AS total, company_id 
    INTO v_rec FROM busy_ufo_expenses WHERE request_id = p_request_id LIMIT 1;
    IF FOUND THEN
        RETURN jsonb_build_object('found', true, 'doc_type', 'EXPENSE', 'id', v_rec.id, 'doc_number', v_rec.doc_number, 'company_id', v_rec.company_id);
    END IF;

    RETURN jsonb_build_object('found', false);
END;
$$ LANGUAGE plpgsql;

-- 3. Atomic Update Sale Invoice RPC (Separate Create and Edit Logic)
CREATE OR REPLACE FUNCTION update_sale_invoice_rpc(
    p_request_id VARCHAR,
    p_company_id VARCHAR,
    p_invoice_id VARCHAR,
    p_customer_id VARCHAR,
    p_customer_name VARCHAR,
    p_sale_type VARCHAR,
    p_invoice_date DATE,
    p_total_amount NUMERIC,
    p_overall_discount NUMERIC,
    p_grand_total NUMERIC,
    p_paid_amount NUMERIC,
    p_due_amount NUMERIC,
    p_notes TEXT,
    p_items JSONB
) RETURNS JSONB AS $$
DECLARE
    v_existing_sale RECORD;
    v_item RECORD;
    v_orig_item RECORD;
    v_payment_status VARCHAR;
    v_allow_negative BOOLEAN := FALSE;
    v_prod_stock NUMERIC;
    v_req_qty NUMERIC;
BEGIN
    -- 1. Idempotency check on request_id if already processed for this update
    -- (In production, if request_id matches a previous update response, return success)
    
    -- 2. Lock existing sale invoice row
    SELECT * INTO v_existing_sale FROM busy_ufo_sales WHERE id = p_invoice_id AND company_id = p_company_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Sale invoice not found or company mismatch.');
    END IF;

    -- 3. Reverse Original Stock Effect (Add back original quantities to inventory)
    FOR v_orig_item IN SELECT product_id, quantity FROM busy_ufo_sale_items WHERE invoice_id = p_invoice_id LOOP
        IF v_orig_item.product_id IS NOT NULL THEN
            UPDATE busy_ufo_products
            SET current_stock = current_stock + v_orig_item.quantity,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = v_orig_item.product_id;
        END IF;
    END LOOP;

    -- 4. Reverse Original Customer Balance Effect
    IF v_existing_sale.customer_id IS NOT NULL AND COALESCE(v_existing_sale.due_amount, 0) > 0 THEN
        UPDATE busy_ufo_customers
        SET current_balance = current_balance - v_existing_sale.due_amount,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = v_existing_sale.customer_id;
    END IF;

    -- 5. Check Negative Stock Policy for New Items
    SELECT COALESCE(allow_negative_stock, FALSE) INTO v_allow_negative FROM busy_ufo_settings LIMIT 1;
    
    IF NOT v_allow_negative THEN
        FOR v_item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(productId VARCHAR, quantity NUMERIC) LOOP
            IF v_item.productId IS NOT NULL THEN
                SELECT current_stock INTO v_prod_stock FROM busy_ufo_products WHERE id = v_item.productId FOR UPDATE;
                IF NOT FOUND OR v_prod_stock < v_item.quantity THEN
                    RAISE EXCEPTION 'Insufficient stock for product ID %. Available: %, Required: %', v_item.productId, COALESCE(v_prod_stock, 0), v_item.quantity;
                END IF;
            END IF;
        END LOOP;
    END IF;

    -- 6. Apply New Stock Deduction
    FOR v_item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(productId VARCHAR, quantity NUMERIC) LOOP
        IF v_item.productId IS NOT NULL THEN
            UPDATE busy_ufo_products
            SET current_stock = current_stock - v_item.quantity,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = v_item.productId;
        END IF;
    END LOOP;

    -- 7. Apply New Customer Balance
    IF p_customer_id IS NOT NULL AND p_due_amount > 0 THEN
        UPDATE busy_ufo_customers
        SET current_balance = current_balance + p_due_amount,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = p_customer_id;
    END IF;

    -- 8. Determine Payment Status
    v_payment_status := CASE WHEN p_due_amount <= 0 THEN 'PAID' WHEN p_paid_amount > 0 THEN 'PARTIAL' ELSE 'UNPAID' END;

    -- 9. Update Invoice Header
    UPDATE busy_ufo_sales
    SET customer_id = p_customer_id,
        customer_name = p_customer_name,
        sale_type = p_sale_type,
        invoice_date = p_invoice_date,
        total_amount = p_total_amount,
        overall_discount = p_overall_discount,
        grand_total = p_grand_total,
        paid_amount = p_paid_amount,
        due_amount = p_due_amount,
        payment_status = v_payment_status,
        notes = p_notes,
        request_id = COALESCE(p_request_id, request_id),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = p_invoice_id;

    -- 10. Replace Invoice Items Safely
    DELETE FROM busy_ufo_sale_items WHERE invoice_id = p_invoice_id;

    INSERT INTO busy_ufo_sale_items (invoice_id, product_id, product_code, product_name, quantity, unit_price, discount, discount_type, total)
    SELECT 
        p_invoice_id,
        x.productId,
        x.productCode,
        x.productName,
        x.quantity,
        x.unitPrice,
        x.discount,
        x.discountType,
        x.total
    FROM jsonb_to_recordset(p_items) AS x(
        productId VARCHAR,
        productCode VARCHAR,
        productName VARCHAR,
        quantity NUMERIC,
        unitPrice NUMERIC,
        discount NUMERIC,
        discountType VARCHAR,
        total NUMERIC
    );

    RETURN jsonb_build_object(
        'success', true,
        'data', jsonb_build_object(
            'id', p_invoice_id,
            'invoice_number', v_existing_sale.invoice_number,
            'request_id', p_request_id
        )
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$ LANGUAGE plpgsql;


-- 4. Atomic Update Purchase Invoice RPC (Separate Create and Edit Logic)
CREATE OR REPLACE FUNCTION update_purchase_invoice_rpc(
    p_request_id VARCHAR,
    p_company_id VARCHAR,
    p_purchase_id VARCHAR,
    p_supplier_id VARCHAR,
    p_supplier_name VARCHAR,
    p_purchase_type VARCHAR,
    p_purchase_date DATE,
    p_total_amount NUMERIC,
    p_overall_discount NUMERIC,
    p_grand_total NUMERIC,
    p_paid_amount NUMERIC,
    p_due_amount NUMERIC,
    p_notes TEXT,
    p_items JSONB
) RETURNS JSONB AS $$
DECLARE
    v_existing_pur RECORD;
    v_orig_item RECORD;
    v_item RECORD;
    v_payment_status VARCHAR;
BEGIN
    -- 1. Lock existing purchase row
    SELECT * INTO v_existing_pur FROM busy_ufo_purchases WHERE id = p_purchase_id AND company_id = p_company_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Purchase invoice not found or company mismatch.');
    END IF;

    -- 2. Reverse Original Stock Effect (Subtract original quantities from inventory)
    FOR v_orig_item IN SELECT product_id, quantity FROM busy_ufo_purchase_items WHERE purchase_id = p_purchase_id LOOP
        IF v_orig_item.product_id IS NOT NULL THEN
            UPDATE busy_ufo_products
            SET current_stock = GREATEST(0, current_stock - v_orig_item.quantity),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = v_orig_item.product_id;
        END IF;
    END LOOP;

    -- 3. Reverse Original Supplier Balance Effect
    IF v_existing_pur.supplier_id IS NOT NULL AND COALESCE(v_existing_pur.due_amount, 0) > 0 THEN
        UPDATE busy_ufo_suppliers
        SET current_balance = current_balance - v_existing_pur.due_amount,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = v_existing_pur.supplier_id;
    END IF;

    -- 4. Apply New Stock Addition
    FOR v_item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(productId VARCHAR, quantity NUMERIC) LOOP
        IF v_item.productId IS NOT NULL THEN
            UPDATE busy_ufo_products
            SET current_stock = current_stock + v_item.quantity,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = v_item.productId;
        END IF;
    END LOOP;

    -- 5. Apply New Supplier Balance
    IF p_supplier_id IS NOT NULL AND p_due_amount > 0 THEN
        UPDATE busy_ufo_suppliers
        SET current_balance = current_balance + p_due_amount,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = p_supplier_id;
    END IF;

    -- 6. Determine Payment Status
    v_payment_status := CASE WHEN p_due_amount <= 0 THEN 'PAID' WHEN p_paid_amount > 0 THEN 'PARTIAL' ELSE 'UNPAID' END;

    -- 7. Update Purchase Header
    UPDATE busy_ufo_purchases
    SET supplier_id = p_supplier_id,
        supplier_name = p_supplier_name,
        purchase_type = p_purchase_type,
        purchase_date = p_purchase_date,
        total_amount = p_total_amount,
        overall_discount = p_overall_discount,
        grand_total = p_grand_total,
        paid_amount = p_paid_amount,
        due_amount = p_due_amount,
        payment_status = v_payment_status,
        notes = p_notes,
        request_id = COALESCE(p_request_id, request_id),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = p_purchase_id;

    -- 8. Replace Purchase Items Safely
    DELETE FROM busy_ufo_purchase_items WHERE purchase_id = p_purchase_id;

    INSERT INTO busy_ufo_purchase_items (purchase_id, product_id, product_code, product_name, quantity, unit_cost, discount, discount_type, total)
    SELECT 
        p_purchase_id,
        x.productId,
        x.productCode,
        x.productName,
        x.quantity,
        x.unitCost,
        x.discount,
        x.discountType,
        x.total
    FROM jsonb_to_recordset(p_items) AS x(
        productId VARCHAR,
        productCode VARCHAR,
        productName VARCHAR,
        quantity NUMERIC,
        unitCost NUMERIC,
        discount NUMERIC,
        discountType VARCHAR,
        total NUMERIC
    );

    RETURN jsonb_build_object(
        'success', true,
        'data', jsonb_build_object(
            'id', p_purchase_id,
            'purchase_number', v_existing_pur.purchase_number,
            'request_id', p_request_id
        )
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$ LANGUAGE plpgsql;
