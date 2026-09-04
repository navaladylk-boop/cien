-- ============================================================
-- MIGRATION: 20260904_production_transaction_safety.sql
-- Production Transaction Safety, Atomic Edits, Returns & Timeout Recovery
-- Non-destructive forward-only migration for live ERP / Accounting DB.
-- ============================================================

-- 1. Ensure columns exist for idempotency and JSON item storage
ALTER TABLE IF EXISTS busy_ufo_sales ADD COLUMN IF NOT EXISTS last_update_request_id VARCHAR(100);
ALTER TABLE IF EXISTS busy_ufo_purchases ADD COLUMN IF NOT EXISTS last_update_request_id VARCHAR(100);

ALTER TABLE IF EXISTS busy_ufo_sales_returns ADD COLUMN IF NOT EXISTS request_id VARCHAR(100);
ALTER TABLE IF EXISTS busy_ufo_sales_returns ADD COLUMN IF NOT EXISTS items JSONB;

ALTER TABLE IF EXISTS busy_ufo_purchase_returns ADD COLUMN IF NOT EXISTS request_id VARCHAR(100);
ALTER TABLE IF EXISTS busy_ufo_purchase_returns ADD COLUMN IF NOT EXISTS items JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_returns_request_id ON busy_ufo_sales_returns(request_id) WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_returns_request_id ON busy_ufo_purchase_returns(request_id) WHERE request_id IS NOT NULL;

-- 2. Timeout Recovery Helper: Check transaction existence by request_id across all transaction tables
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

    -- Check Sales Returns
    SELECT id, return_number AS doc_number, 'SALES_RETURN' AS doc_type, grand_total AS total, company_id 
    INTO v_rec FROM busy_ufo_sales_returns WHERE request_id = p_request_id LIMIT 1;
    IF FOUND THEN
        RETURN jsonb_build_object('found', true, 'doc_type', 'SALES_RETURN', 'id', v_rec.id, 'doc_number', v_rec.doc_number, 'company_id', v_rec.company_id);
    END IF;

    -- Check Purchase Returns
    SELECT id, return_number AS doc_number, 'PURCHASE_RETURN' AS doc_type, grand_total AS total, company_id 
    INTO v_rec FROM busy_ufo_purchase_returns WHERE request_id = p_request_id LIMIT 1;
    IF FOUND THEN
        RETURN jsonb_build_object('found', true, 'doc_type', 'PURCHASE_RETURN', 'id', v_rec.id, 'doc_number', v_rec.doc_number, 'company_id', v_rec.company_id);
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
BEGIN
    -- 1. Lock existing sale invoice row
    SELECT * INTO v_existing_sale FROM busy_ufo_sales WHERE id = p_invoice_id AND company_id = p_company_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Sale invoice not found or company mismatch.');
    END IF;

    -- 2. Update Idempotency: If this exact update request was already committed, return success immediately
    IF p_request_id IS NOT NULL AND p_request_id <> '' AND v_existing_sale.last_update_request_id = p_request_id THEN
        RETURN jsonb_build_object(
            'success', true,
            'is_duplicate', true,
            'data', jsonb_build_object(
                'id', p_invoice_id,
                'invoice_number', v_existing_sale.invoice_number,
                'request_id', p_request_id
            )
        );
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

    -- 6. Apply New Stock Deduction (Mathematically exact, no GREATEST(0, ...))
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
        last_update_request_id = p_request_id,
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
    v_allow_negative BOOLEAN := FALSE;
    v_prod_stock NUMERIC;
BEGIN
    -- 1. Lock existing purchase row
    SELECT * INTO v_existing_pur FROM busy_ufo_purchases WHERE id = p_purchase_id AND company_id = p_company_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Purchase invoice not found or company mismatch.');
    END IF;

    -- 2. Update Idempotency: If this exact update was already applied, return immediately
    IF p_request_id IS NOT NULL AND p_request_id <> '' AND v_existing_pur.last_update_request_id = p_request_id THEN
        RETURN jsonb_build_object(
            'success', true,
            'is_duplicate', true,
            'data', jsonb_build_object(
                'id', p_purchase_id,
                'purchase_number', v_existing_pur.purchase_number,
                'request_id', p_request_id
            )
        );
    END IF;

    SELECT COALESCE(allow_negative_stock, FALSE) INTO v_allow_negative FROM busy_ufo_settings LIMIT 1;

    -- 3. Reverse Original Stock Effect (Subtract original quantities from inventory)
    -- RULE: NO GREATEST(0, ...). Must be mathematically correct. If negative not allowed, verify availability.
    FOR v_orig_item IN SELECT product_id, quantity FROM busy_ufo_purchase_items WHERE purchase_id = p_purchase_id LOOP
        IF v_orig_item.product_id IS NOT NULL THEN
            SELECT current_stock INTO v_prod_stock FROM busy_ufo_products WHERE id = v_orig_item.product_id FOR UPDATE;
            IF NOT v_allow_negative AND (v_prod_stock - v_orig_item.quantity) < 0 THEN
                RAISE EXCEPTION 'Cannot reverse purchase: product ID % would have negative stock (current: %, removing: %)', 
                    v_orig_item.product_id, COALESCE(v_prod_stock, 0), v_orig_item.quantity;
            END IF;

            UPDATE busy_ufo_products
            SET current_stock = current_stock - v_orig_item.quantity,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = v_orig_item.product_id;
        END IF;
    END LOOP;

    -- 4. Reverse Original Supplier Balance Effect
    IF v_existing_pur.supplier_id IS NOT NULL AND COALESCE(v_existing_pur.due_amount, 0) > 0 THEN
        UPDATE busy_ufo_suppliers
        SET current_balance = current_balance - v_existing_pur.due_amount,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = v_existing_pur.supplier_id;
    END IF;

    -- 5. Apply New Stock Addition
    FOR v_item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(productId VARCHAR, quantity NUMERIC) LOOP
        IF v_item.productId IS NOT NULL THEN
            UPDATE busy_ufo_products
            SET current_stock = current_stock + v_item.quantity,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = v_item.productId;
        END IF;
    END LOOP;

    -- 6. Apply New Supplier Balance
    IF p_supplier_id IS NOT NULL AND p_due_amount > 0 THEN
        UPDATE busy_ufo_suppliers
        SET current_balance = current_balance + p_due_amount,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = p_supplier_id;
    END IF;

    -- 7. Determine Payment Status
    v_payment_status := CASE WHEN p_due_amount <= 0 THEN 'PAID' WHEN p_paid_amount > 0 THEN 'PARTIAL' ELSE 'UNPAID' END;

    -- 8. Update Purchase Header
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
        last_update_request_id = p_request_id,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = p_purchase_id;

    -- 9. Replace Purchase Items Safely
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


-- 5. Atomic Sales Return Posting RPC
CREATE OR REPLACE FUNCTION post_sales_return_rpc(
    p_request_id VARCHAR,
    p_company_id VARCHAR,
    p_customer_id VARCHAR,
    p_customer_name VARCHAR,
    p_date DATE,
    p_type VARCHAR,
    p_invoice_id VARCHAR,
    p_invoice_number VARCHAR,
    p_subtotal NUMERIC,
    p_discount NUMERIC,
    p_grand_total NUMERIC,
    p_refunded_amount NUMERIC,
    p_reason TEXT,
    p_notes TEXT,
    p_items JSONB
) RETURNS JSONB AS $$
DECLARE
    v_return_number VARCHAR(50);
    v_return_id VARCHAR(100);
    v_existing RECORD;
    v_item RECORD;
BEGIN
    -- 1. Idempotency check
    IF p_request_id IS NOT NULL AND p_request_id <> '' THEN
        SELECT id, return_number, request_id INTO v_existing FROM busy_ufo_sales_returns WHERE request_id = p_request_id LIMIT 1;
        IF FOUND THEN
            RETURN jsonb_build_object('success', true, 'is_duplicate', true, 'data', jsonb_build_object('id', v_existing.id, 'return_number', v_existing.return_number, 'request_id', v_existing.request_id));
        END IF;
    END IF;

    -- 2. Document Number Generation
    v_return_number := allocate_document_number_atomic(p_company_id, 'SALES_RETURN', 'SR', p_date);
    v_return_id := 'sr-' || EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)::BIGINT || '-' || floor(random() * 1000)::TEXT;

    -- 3. Insert Return Header
    INSERT INTO busy_ufo_sales_returns (
        id, company_id, request_id, return_number, invoice_id, invoice_number,
        date, customer_id, customer_name, type, reason, subtotal, discount,
        grand_total, refunded_amount, notes, status, items, created_at
    ) VALUES (
        v_return_id, p_company_id, p_request_id, v_return_number, p_invoice_id, p_invoice_number,
        p_date, p_customer_id, p_customer_name, p_type, p_reason, p_subtotal, p_discount,
        p_grand_total, p_refunded_amount, p_notes, 'COMPLETED', p_items, CURRENT_TIMESTAMP
    );

    -- 4. Restore Stock (Add back returned items)
    FOR v_item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(productId VARCHAR, quantity NUMERIC) LOOP
        IF v_item.productId IS NOT NULL THEN
            UPDATE busy_ufo_products
            SET current_stock = current_stock + v_item.quantity,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = v_item.productId;
        END IF;
    END LOOP;

    -- 5. Adjust Customer Balance if Credit Return
    IF p_type = 'CREDIT' AND p_customer_id IS NOT NULL AND p_customer_id <> '' THEN
        UPDATE busy_ufo_customers
        SET current_balance = current_balance - p_grand_total,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = p_customer_id;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'data', jsonb_build_object(
            'id', v_return_id,
            'return_number', v_return_number,
            'request_id', p_request_id
        )
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$ LANGUAGE plpgsql;


-- 6. Atomic Purchase Return Posting RPC
CREATE OR REPLACE FUNCTION post_purchase_return_rpc(
    p_request_id VARCHAR,
    p_company_id VARCHAR,
    p_supplier_id VARCHAR,
    p_supplier_name VARCHAR,
    p_date DATE,
    p_type VARCHAR,
    p_purchase_id VARCHAR,
    p_purchase_number VARCHAR,
    p_subtotal NUMERIC,
    p_discount NUMERIC,
    p_grand_total NUMERIC,
    p_reason TEXT,
    p_notes TEXT,
    p_items JSONB
) RETURNS JSONB AS $$
DECLARE
    v_return_number VARCHAR(50);
    v_return_id VARCHAR(100);
    v_existing RECORD;
    v_item RECORD;
    v_allow_negative BOOLEAN := FALSE;
    v_prod_stock NUMERIC;
BEGIN
    -- 1. Idempotency check
    IF p_request_id IS NOT NULL AND p_request_id <> '' THEN
        SELECT id, return_number, request_id INTO v_existing FROM busy_ufo_purchase_returns WHERE request_id = p_request_id LIMIT 1;
        IF FOUND THEN
            RETURN jsonb_build_object('success', true, 'is_duplicate', true, 'data', jsonb_build_object('id', v_existing.id, 'return_number', v_existing.return_number, 'request_id', v_existing.request_id));
        END IF;
    END IF;

    SELECT COALESCE(allow_negative_stock, FALSE) INTO v_allow_negative FROM busy_ufo_settings LIMIT 1;

    -- 2. Verify stock availability (NO GREATEST(0, ...)!)
    IF NOT v_allow_negative THEN
        FOR v_item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(productId VARCHAR, quantity NUMERIC) LOOP
            IF v_item.productId IS NOT NULL THEN
                SELECT current_stock INTO v_prod_stock FROM busy_ufo_products WHERE id = v_item.productId FOR UPDATE;
                IF NOT FOUND OR v_prod_stock < v_item.quantity THEN
                    RAISE EXCEPTION 'Insufficient stock to return product ID %. Available: %, Required: %', 
                        v_item.productId, COALESCE(v_prod_stock, 0), v_item.quantity;
                END IF;
            END IF;
        END LOOP;
    END IF;

    -- 3. Document Number Generation
    v_return_number := allocate_document_number_atomic(p_company_id, 'PURCHASE_RETURN', 'PR', p_date);
    v_return_id := 'pr-' || EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)::BIGINT || '-' || floor(random() * 1000)::TEXT;

    -- 4. Insert Return Header
    INSERT INTO busy_ufo_purchase_returns (
        id, company_id, request_id, return_number, purchase_id, purchase_number,
        date, supplier_id, supplier_name, type, reason, subtotal, discount,
        grand_total, notes, status, items, created_at
    ) VALUES (
        v_return_id, p_company_id, p_request_id, v_return_number, p_purchase_id, p_purchase_number,
        p_date, p_supplier_id, p_supplier_name, p_type, p_reason, p_subtotal, p_discount,
        p_grand_total, p_notes, 'COMPLETED', p_items, CURRENT_TIMESTAMP
    );

    -- 5. Deduct Stock (Stock OUT)
    FOR v_item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(productId VARCHAR, quantity NUMERIC) LOOP
        IF v_item.productId IS NOT NULL THEN
            UPDATE busy_ufo_products
            SET current_stock = current_stock - v_item.quantity,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = v_item.productId;
        END IF;
    END LOOP;

    -- 6. Adjust Supplier Balance if Credit Return
    IF p_type = 'CREDIT' AND p_supplier_id IS NOT NULL AND p_supplier_id <> '' THEN
        UPDATE busy_ufo_suppliers
        SET current_balance = current_balance - p_grand_total,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = p_supplier_id;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'data', jsonb_build_object(
            'id', v_return_id,
            'return_number', v_return_number,
            'request_id', p_request_id
        )
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$ LANGUAGE plpgsql;
