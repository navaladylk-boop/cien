-- =========================================================================
-- BUSY UFO ERP - MASTER ATOMIC RPC & SCHEMA CACHE RELOAD
-- Safe for existing production data: only creates/replaces functions and views.
-- =========================================================================

-- 1. Helper: Allocate Document Number
CREATE OR REPLACE FUNCTION allocate_document_number_atomic(
    p_company_id VARCHAR,
    p_doc_type VARCHAR,
    p_prefix VARCHAR,
    p_date DATE
) RETURNS VARCHAR AS $$
DECLARE
    v_year VARCHAR(4);
    v_seq_name VARCHAR(100);
    v_next_val BIGINT;
    v_formatted_no VARCHAR(50);
BEGIN
    v_year := TO_CHAR(COALESCE(p_date, CURRENT_DATE), 'YYYY');
    v_seq_name := 'seq_doc_' || LOWER(REGEXP_REPLACE(COALESCE(p_company_id, 'comp_1'), '[^a-zA-Z0-9_]', '_', 'g')) || '_' || LOWER(p_doc_type) || '_' || v_year;
    
    BEGIN
        EXECUTE 'CREATE SEQUENCE IF NOT EXISTS ' || quote_ident(v_seq_name) || ' START WITH 1';
    EXCEPTION
        WHEN OTHERS THEN
            NULL;
    END;

    EXECUTE 'SELECT nextval(' || quote_literal(v_seq_name) || ')' INTO v_next_val;
    v_formatted_no := p_prefix || '-' || v_year || '-' || LPAD(v_next_val::TEXT, 4, '0');
    RETURN v_formatted_no;
END;
$$ LANGUAGE plpgsql;

-- 2. Number Generators
CREATE OR REPLACE FUNCTION generate_next_sales_invoice_number_rpc(p_company_id VARCHAR) RETURNS VARCHAR AS $$
BEGIN
    RETURN allocate_document_number_atomic(p_company_id, 'SALE', 'INV', CURRENT_DATE);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION generate_next_purchase_number_rpc(p_company_id VARCHAR) RETURNS VARCHAR AS $$
BEGIN
    RETURN allocate_document_number_atomic(p_company_id, 'PURCHASE', 'PUR', CURRENT_DATE);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION generate_next_receipt_number_rpc(p_company_id VARCHAR) RETURNS VARCHAR AS $$
BEGIN
    RETURN allocate_document_number_atomic(p_company_id, 'RECEIPT', 'REC', CURRENT_DATE);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION generate_next_payment_number_rpc(p_company_id VARCHAR) RETURNS VARCHAR AS $$
BEGIN
    RETURN allocate_document_number_atomic(p_company_id, 'PAYMENT', 'PAY', CURRENT_DATE);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION generate_next_expense_number_rpc(p_company_id VARCHAR) RETURNS VARCHAR AS $$
BEGIN
    RETURN allocate_document_number_atomic(p_company_id, 'EXPENSE', 'EXP', CURRENT_DATE);
END;
$$ LANGUAGE plpgsql;

-- 3. Supplier Payments
CREATE OR REPLACE FUNCTION post_supplier_payment_rpc(
    p_request_id VARCHAR,
    p_company_id VARCHAR,
    p_supplier_id VARCHAR,
    p_supplier_name VARCHAR,
    p_date DATE,
    p_amount NUMERIC,
    p_payment_method VARCHAR,
    p_reference_no VARCHAR,
    p_notes TEXT
) RETURNS JSONB AS $$
DECLARE
    v_payment_number VARCHAR(50);
    v_payment_id VARCHAR(100);
    v_existing JSONB;
BEGIN
    SELECT row_to_json(p) INTO v_existing FROM busy_ufo_supplier_payments p WHERE request_id = p_request_id LIMIT 1;
    IF v_existing IS NOT NULL THEN
        RETURN jsonb_build_object('success', true, 'is_duplicate', true, 'data', v_existing);
    END IF;

    v_payment_number := allocate_document_number_atomic(p_company_id, 'PAYMENT', 'PAY', p_date);
    v_payment_id := 'pay-' || EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)::BIGINT || '-' || floor(random() * 1000)::TEXT;

    INSERT INTO busy_ufo_supplier_payments (
        id, request_id, payment_number, date, supplier_id, supplier_name,
        amount, payment_method, reference_no, notes, company_id
    ) VALUES (
        v_payment_id, p_request_id, v_payment_number, p_date, p_supplier_id, p_supplier_name,
        p_amount, p_payment_method, p_reference_no, p_notes, p_company_id
    );

    IF p_supplier_id IS NOT NULL AND p_supplier_id <> '' THEN
        UPDATE busy_ufo_suppliers
        SET current_balance = GREATEST(0, current_balance - p_amount),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = p_supplier_id AND company_id = p_company_id;
    END IF;

    SELECT row_to_json(p) INTO v_existing FROM busy_ufo_supplier_payments p WHERE id = v_payment_id;
    RETURN jsonb_build_object('success', true, 'data', v_existing);
EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Supplier payment posting failed: %', SQLERRM;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION void_supplier_payment_rpc(
    p_payment_id VARCHAR,
    p_company_id VARCHAR,
    p_request_id VARCHAR
) RETURNS JSONB AS $$
DECLARE
    v_pay RECORD;
BEGIN
    SELECT * INTO v_pay FROM busy_ufo_supplier_payments WHERE id = p_payment_id AND company_id = p_company_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Supplier payment not found');
    END IF;

    DELETE FROM busy_ufo_supplier_payments WHERE id = p_payment_id AND company_id = p_company_id;

    IF v_pay.supplier_id IS NOT NULL AND v_pay.supplier_id <> '' THEN
        UPDATE busy_ufo_suppliers
        SET current_balance = current_balance + v_pay.amount,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = v_pay.supplier_id AND company_id = p_company_id;
    END IF;

    RETURN jsonb_build_object('success', true);
EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Void supplier payment failed: %', SQLERRM;
END;
$$ LANGUAGE plpgsql;

-- 4. Customer Receipts
CREATE OR REPLACE FUNCTION post_customer_receipt_rpc(
    p_request_id VARCHAR,
    p_company_id VARCHAR,
    p_customer_id VARCHAR,
    p_customer_name VARCHAR,
    p_date DATE,
    p_amount NUMERIC,
    p_payment_method VARCHAR,
    p_reference_no VARCHAR,
    p_notes TEXT
) RETURNS JSONB AS $$
DECLARE
    v_receipt_number VARCHAR(50);
    v_receipt_id VARCHAR(100);
    v_existing JSONB;
BEGIN
    SELECT row_to_json(r) INTO v_existing FROM busy_ufo_customer_receipts r WHERE request_id = p_request_id LIMIT 1;
    IF v_existing IS NOT NULL THEN
        RETURN jsonb_build_object('success', true, 'is_duplicate', true, 'data', v_existing);
    END IF;

    v_receipt_number := allocate_document_number_atomic(p_company_id, 'RECEIPT', 'REC', p_date);
    v_receipt_id := 'rec-' || EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)::BIGINT || '-' || floor(random() * 1000)::TEXT;

    INSERT INTO busy_ufo_customer_receipts (
        id, request_id, receipt_number, date, customer_id, customer_name,
        amount, payment_method, reference_no, notes, company_id
    ) VALUES (
        v_receipt_id, p_request_id, v_receipt_number, p_date, p_customer_id, p_customer_name,
        p_amount, p_payment_method, p_reference_no, p_notes, p_company_id
    );

    IF p_customer_id IS NOT NULL AND p_customer_id <> '' THEN
        UPDATE busy_ufo_customers
        SET current_balance = GREATEST(0, current_balance - p_amount),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = p_customer_id AND company_id = p_company_id;
    END IF;

    SELECT row_to_json(r) INTO v_existing FROM busy_ufo_customer_receipts r WHERE id = v_receipt_id;
    RETURN jsonb_build_object('success', true, 'data', v_existing);
EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Customer receipt posting failed: %', SQLERRM;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION void_customer_receipt_rpc(
    p_receipt_id VARCHAR,
    p_company_id VARCHAR,
    p_request_id VARCHAR
) RETURNS JSONB AS $$
DECLARE
    v_rec RECORD;
BEGIN
    SELECT * INTO v_rec FROM busy_ufo_customer_receipts WHERE id = p_receipt_id AND company_id = p_company_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Customer receipt not found');
    END IF;

    DELETE FROM busy_ufo_customer_receipts WHERE id = p_receipt_id AND company_id = p_company_id;

    IF v_rec.customer_id IS NOT NULL AND v_rec.customer_id <> '' THEN
        UPDATE busy_ufo_customers
        SET current_balance = current_balance + v_rec.amount,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = v_rec.customer_id AND company_id = p_company_id;
    END IF;

    RETURN jsonb_build_object('success', true);
EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Void customer receipt failed: %', SQLERRM;
END;
$$ LANGUAGE plpgsql;

-- 5. Sales Returns
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
    v_existing JSONB;
    v_item JSONB;
    v_prod_id VARCHAR(50);
    v_qty NUMERIC;
    v_price NUMERIC;
    v_line_total NUMERIC;
    v_item_id VARCHAR(100);
BEGIN
    SELECT row_to_json(r) INTO v_existing FROM busy_ufo_sale_returns r WHERE request_id = p_request_id LIMIT 1;
    IF v_existing IS NOT NULL THEN
        RETURN jsonb_build_object('success', true, 'is_duplicate', true, 'data', v_existing);
    END IF;

    v_return_number := allocate_document_number_atomic(p_company_id, 'SALES_RETURN', 'SR', p_date);
    v_return_id := 'sr-' || EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)::BIGINT || '-' || floor(random() * 1000)::TEXT;

    INSERT INTO busy_ufo_sale_returns (
        id, request_id, return_number, date, customer_id, customer_name,
        type, invoice_id, invoice_number, subtotal, discount, grand_total,
        refunded_amount, reason, notes, company_id
    ) VALUES (
        v_return_id, p_request_id, v_return_number, p_date, p_customer_id, p_customer_name,
        p_type, p_invoice_id, p_invoice_number, p_subtotal, p_discount, p_grand_total,
        p_refunded_amount, p_reason, p_notes, p_company_id
    );

    IF p_items IS NOT NULL AND jsonb_array_length(p_items) > 0 THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
        LOOP
            v_prod_id := v_item->>'productId';
            v_qty := COALESCE((v_item->>'quantity')::NUMERIC, 0);
            v_price := COALESCE((v_item->>'unitPrice')::NUMERIC, 0);
            v_line_total := COALESCE((v_item->>'total')::NUMERIC, 0);
            v_item_id := 'sri-' || EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)::BIGINT || '-' || floor(random() * 10000)::TEXT;

            INSERT INTO busy_ufo_sale_return_items (
                id, return_id, product_id, product_code, product_name,
                quantity, unit_price, total
            ) VALUES (
                v_item_id, v_return_id, v_prod_id, COALESCE(v_item->>'productCode', ''), COALESCE(v_item->>'productName', ''),
                v_qty, v_price, v_line_total
            );

            IF v_prod_id IS NOT NULL AND v_prod_id <> '' THEN
                UPDATE busy_ufo_products
                SET stock = stock + v_qty,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = v_prod_id AND company_id = p_company_id;
            END IF;
        END LOOP;
    END IF;

    IF p_customer_id IS NOT NULL AND p_customer_id <> '' AND p_type = 'CREDIT' THEN
        UPDATE busy_ufo_customers
        SET current_balance = GREATEST(0, current_balance - p_grand_total),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = p_customer_id AND company_id = p_company_id;
    END IF;

    SELECT row_to_json(r) INTO v_existing FROM busy_ufo_sale_returns r WHERE id = v_return_id;
    RETURN jsonb_build_object('success', true, 'data', v_existing);
EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Sales return posting failed: %', SQLERRM;
END;
$$ LANGUAGE plpgsql;

-- 6. Expenses
CREATE OR REPLACE FUNCTION post_expense_rpc(
    p_request_id VARCHAR,
    p_company_id VARCHAR,
    p_date DATE,
    p_category VARCHAR,
    p_amount NUMERIC,
    p_paid_to VARCHAR,
    p_payment_method VARCHAR,
    p_notes TEXT
) RETURNS JSONB AS $$
DECLARE
    v_expense_number VARCHAR(50);
    v_expense_id VARCHAR(100);
    v_existing JSONB;
BEGIN
    SELECT row_to_json(e) INTO v_existing FROM busy_ufo_expenses e WHERE request_id = p_request_id LIMIT 1;
    IF v_existing IS NOT NULL THEN
        RETURN jsonb_build_object('success', true, 'is_duplicate', true, 'data', v_existing);
    END IF;

    v_expense_number := allocate_document_number_atomic(p_company_id, 'EXPENSE', 'EXP', p_date);
    v_expense_id := 'exp-' || EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)::BIGINT || '-' || floor(random() * 1000)::TEXT;

    INSERT INTO busy_ufo_expenses (
        id, request_id, expense_number, date, category,
        amount, paid_to, payment_method, notes, company_id
    ) VALUES (
        v_expense_id, p_request_id, v_expense_number, p_date, p_category,
        p_amount, p_paid_to, p_payment_method, p_notes, p_company_id
    );

    SELECT row_to_json(e) INTO v_existing FROM busy_ufo_expenses e WHERE id = v_expense_id;
    RETURN jsonb_build_object('success', true, 'data', v_existing);
EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Expense posting failed: %', SQLERRM;
END;
$$ LANGUAGE plpgsql;

-- 7. Grant Permissions to all
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;

-- 8. Refresh PostgREST Schema Cache
NOTIFY pgrst, 'reload schema';
