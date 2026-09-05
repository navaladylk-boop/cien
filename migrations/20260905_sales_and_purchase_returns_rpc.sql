-- =========================================================================
-- BUSY UFO ERP - Sales & Purchase Returns Atomic RPC Migration
-- =========================================================================

-- 1. Ensure Sales Return Tables Exist
CREATE TABLE IF NOT EXISTS busy_ufo_sale_returns (
    id VARCHAR(100) PRIMARY KEY,
    request_id VARCHAR(100),
    return_number VARCHAR(50),
    date DATE NOT NULL,
    customer_id VARCHAR(50) REFERENCES busy_ufo_customers(id) ON DELETE SET NULL,
    customer_name VARCHAR(150),
    type VARCHAR(30) DEFAULT 'CASH',
    invoice_id VARCHAR(50) REFERENCES busy_ufo_sales(id) ON DELETE SET NULL,
    invoice_number VARCHAR(50),
    subtotal NUMERIC(12, 2) DEFAULT 0.00,
    discount NUMERIC(12, 2) DEFAULT 0.00,
    grand_total NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    refunded_amount NUMERIC(12, 2) DEFAULT 0.00,
    reason TEXT,
    notes TEXT,
    company_id VARCHAR(50) REFERENCES companies(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS busy_ufo_sale_return_items (
    id VARCHAR(100) PRIMARY KEY,
    return_id VARCHAR(100) REFERENCES busy_ufo_sale_returns(id) ON DELETE CASCADE,
    product_id VARCHAR(50) REFERENCES busy_ufo_products(id) ON DELETE SET NULL,
    product_code VARCHAR(50),
    product_name VARCHAR(150),
    quantity NUMERIC(12, 2) NOT NULL DEFAULT 1,
    unit_price NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    total NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Ensure Purchase Return Tables Exist
CREATE TABLE IF NOT EXISTS busy_ufo_purchase_returns (
    id VARCHAR(100) PRIMARY KEY,
    request_id VARCHAR(100),
    return_number VARCHAR(50),
    date DATE NOT NULL,
    supplier_id VARCHAR(50) REFERENCES busy_ufo_suppliers(id) ON DELETE SET NULL,
    supplier_name VARCHAR(150),
    type VARCHAR(30) DEFAULT 'CASH',
    purchase_id VARCHAR(50) REFERENCES busy_ufo_purchases(id) ON DELETE SET NULL,
    purchase_number VARCHAR(50),
    subtotal NUMERIC(12, 2) DEFAULT 0.00,
    discount NUMERIC(12, 2) DEFAULT 0.00,
    grand_total NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    reason TEXT,
    notes TEXT,
    company_id VARCHAR(50) REFERENCES companies(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS busy_ufo_purchase_return_items (
    id VARCHAR(100) PRIMARY KEY,
    return_id VARCHAR(100) REFERENCES busy_ufo_purchase_returns(id) ON DELETE CASCADE,
    product_id VARCHAR(50) REFERENCES busy_ufo_products(id) ON DELETE SET NULL,
    product_code VARCHAR(50),
    product_name VARCHAR(150),
    quantity NUMERIC(12, 2) NOT NULL DEFAULT 1,
    unit_cost NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    total NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Post Sales Return RPC
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

    v_return_number := 'SR-' || TO_CHAR(COALESCE(p_date, CURRENT_DATE), 'YYYY') || '-' || LPAD(FLOOR(RANDOM() * 9000 + 1000)::TEXT, 4, '0');
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

            -- Restock inventory
            IF v_prod_id IS NOT NULL AND v_prod_id <> '' THEN
                UPDATE busy_ufo_products
                SET stock = stock + v_qty,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = v_prod_id AND company_id = p_company_id;
            END IF;
        END LOOP;
    END IF;

    -- Adjust Customer Balance if Credit Return
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

-- 4. Void Sales Return RPC
CREATE OR REPLACE FUNCTION void_sale_return_rpc(
    p_return_id VARCHAR,
    p_company_id VARCHAR,
    p_request_id VARCHAR
) RETURNS JSONB AS $$
DECLARE
    v_ret RECORD;
    v_item RECORD;
BEGIN
    SELECT * INTO v_ret FROM busy_ufo_sale_returns WHERE id = p_return_id AND company_id = p_company_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Sales return not found');
    END IF;

    -- Reverse stock replenishment
    FOR v_item IN SELECT * FROM busy_ufo_sale_return_items WHERE return_id = p_return_id
    LOOP
        IF v_item.product_id IS NOT NULL THEN
            UPDATE busy_ufo_products
            SET stock = GREATEST(0, stock - v_item.quantity),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = v_item.product_id AND company_id = p_company_id;
        END IF;
    END LOOP;

    -- Reverse customer balance adjustment if Credit
    IF v_ret.customer_id IS NOT NULL AND v_ret.type = 'CREDIT' THEN
        UPDATE busy_ufo_customers
        SET current_balance = current_balance + v_ret.grand_total,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = v_ret.customer_id AND company_id = p_company_id;
    END IF;

    DELETE FROM busy_ufo_sale_return_items WHERE return_id = p_return_id;
    DELETE FROM busy_ufo_sale_returns WHERE id = p_return_id AND company_id = p_company_id;

    RETURN jsonb_build_object('success', true);
EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Void sales return failed: %', SQLERRM;
END;
$$ LANGUAGE plpgsql;

-- 5. Post Purchase Return RPC
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
    v_existing JSONB;
    v_item JSONB;
    v_prod_id VARCHAR(50);
    v_qty NUMERIC;
    v_cost NUMERIC;
    v_line_total NUMERIC;
    v_item_id VARCHAR(100);
BEGIN
    SELECT row_to_json(r) INTO v_existing FROM busy_ufo_purchase_returns r WHERE request_id = p_request_id LIMIT 1;
    IF v_existing IS NOT NULL THEN
        RETURN jsonb_build_object('success', true, 'is_duplicate', true, 'data', v_existing);
    END IF;

    v_return_number := 'PR-' || TO_CHAR(COALESCE(p_date, CURRENT_DATE), 'YYYY') || '-' || LPAD(FLOOR(RANDOM() * 9000 + 1000)::TEXT, 4, '0');
    v_return_id := 'pr-' || EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)::BIGINT || '-' || floor(random() * 1000)::TEXT;

    INSERT INTO busy_ufo_purchase_returns (
        id, request_id, return_number, date, supplier_id, supplier_name,
        type, purchase_id, purchase_number, subtotal, discount, grand_total,
        reason, notes, company_id
    ) VALUES (
        v_return_id, p_request_id, v_return_number, p_date, p_supplier_id, p_supplier_name,
        p_type, p_purchase_id, p_purchase_number, p_subtotal, p_discount, p_grand_total,
        p_reason, p_notes, p_company_id
    );

    IF p_items IS NOT NULL AND jsonb_array_length(p_items) > 0 THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
        LOOP
            v_prod_id := v_item->>'productId';
            v_qty := COALESCE((v_item->>'quantity')::NUMERIC, 0);
            v_cost := COALESCE((v_item->>'unitCost')::NUMERIC, 0);
            v_line_total := COALESCE((v_item->>'total')::NUMERIC, 0);
            v_item_id := 'pri-' || EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)::BIGINT || '-' || floor(random() * 10000)::TEXT;

            INSERT INTO busy_ufo_purchase_return_items (
                id, return_id, product_id, product_code, product_name,
                quantity, unit_cost, total
            ) VALUES (
                v_item_id, v_return_id, v_prod_id, COALESCE(v_item->>'productCode', ''), COALESCE(v_item->>'productName', ''),
                v_qty, v_cost, v_line_total
            );

            -- Deduct stock
            IF v_prod_id IS NOT NULL AND v_prod_id <> '' THEN
                UPDATE busy_ufo_products
                SET stock = GREATEST(0, stock - v_qty),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = v_prod_id AND company_id = p_company_id;
            END IF;
        END LOOP;
    END IF;

    -- Adjust Supplier Balance if Credit Return
    IF p_supplier_id IS NOT NULL AND p_supplier_id <> '' AND p_type = 'CREDIT' THEN
        UPDATE busy_ufo_suppliers
        SET current_balance = GREATEST(0, current_balance - p_grand_total),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = p_supplier_id AND company_id = p_company_id;
    END IF;

    SELECT row_to_json(r) INTO v_existing FROM busy_ufo_purchase_returns r WHERE id = v_return_id;
    RETURN jsonb_build_object('success', true, 'data', v_existing);
EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Purchase return posting failed: %', SQLERRM;
END;
$$ LANGUAGE plpgsql;

-- 6. Void Purchase Return RPC
CREATE OR REPLACE FUNCTION void_purchase_return_rpc(
    p_return_id VARCHAR,
    p_company_id VARCHAR,
    p_request_id VARCHAR
) RETURNS JSONB AS $$
DECLARE
    v_ret RECORD;
    v_item RECORD;
BEGIN
    SELECT * INTO v_ret FROM busy_ufo_purchase_returns WHERE id = p_return_id AND company_id = p_company_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Purchase return not found');
    END IF;

    -- Reverse stock deduction
    FOR v_item IN SELECT * FROM busy_ufo_purchase_return_items WHERE return_id = p_return_id
    LOOP
        IF v_item.product_id IS NOT NULL THEN
            UPDATE busy_ufo_products
            SET stock = stock + v_item.quantity,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = v_item.product_id AND company_id = p_company_id;
        END IF;
    END LOOP;

    -- Reverse supplier balance adjustment if Credit
    IF v_ret.supplier_id IS NOT NULL AND v_ret.type = 'CREDIT' THEN
        UPDATE busy_ufo_suppliers
        SET current_balance = current_balance + v_ret.grand_total,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = v_ret.supplier_id AND company_id = p_company_id;
    END IF;

    DELETE FROM busy_ufo_purchase_return_items WHERE return_id = p_return_id;
    DELETE FROM busy_ufo_purchase_returns WHERE id = p_return_id AND company_id = p_company_id;

    RETURN jsonb_build_object('success', true);
EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Void purchase return failed: %', SQLERRM;
END;
$$ LANGUAGE plpgsql;

-- 7. Grant Permissions & Reload Schema Cache
GRANT EXECUTE ON FUNCTION post_sales_return_rpc TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION void_sale_return_rpc TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION post_purchase_return_rpc TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION void_purchase_return_rpc TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
