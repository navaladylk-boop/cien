-- ============================================================
-- MIGRATION: 20260904_pdc_and_void_rpc_safety.sql
-- Production PDC Atomic Workflow, Void RPCs & Timeout Recovery Safety
-- Forward-only, backward-compatible, strictly non-destructive for live DB.
-- ============================================================

-- 1. Timeout Recovery Helper Enhancement: Check PDC table along with all financial tables
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

    -- Check PDC (Post-Dated Cheques)
    SELECT id, cheque_number AS doc_number, 'PDC' AS doc_type, amount AS total, company_id 
    INTO v_rec FROM busy_ufo_pdcs WHERE request_id = p_request_id LIMIT 1;
    IF FOUND THEN
        RETURN jsonb_build_object('found', true, 'doc_type', 'PDC', 'id', v_rec.id, 'doc_number', v_rec.doc_number, 'company_id', v_rec.company_id);
    END IF;

    RETURN jsonb_build_object('found', false);
END;
$$ LANGUAGE plpgsql;


-- 2. Atomic Update PDC RPC (Supports editing pending/deposited PDCs with strict audit controls)
CREATE OR REPLACE FUNCTION update_pdc_rpc(
    p_pdc_id VARCHAR,
    p_request_id VARCHAR,
    p_company_id VARCHAR,
    p_type VARCHAR,
    p_party_id VARCHAR,
    p_party_type VARCHAR,
    p_party_name VARCHAR,
    p_cheque_number VARCHAR,
    p_bank_name VARCHAR,
    p_cheque_date DATE,
    p_amount NUMERIC,
    p_notes TEXT DEFAULT ''
) RETURNS JSONB AS $$
DECLARE
    v_pdc RECORD;
    v_saved JSONB;
BEGIN
    SELECT * INTO v_pdc FROM busy_ufo_pdcs WHERE id = p_pdc_id AND company_id = p_company_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'PDC record not found or company mismatch.');
    END IF;

    IF v_pdc.status = 'CLEARED' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Cannot edit a CLEARED cheque. Bounce/reverse it first to adjust accounting.');
    END IF;

    IF p_amount <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Cheque amount must be greater than zero.');
    END IF;

    UPDATE busy_ufo_pdcs
    SET type = COALESCE(p_type, type),
        party_id = p_party_id,
        party_type = p_party_type,
        party_name = p_party_name,
        cheque_number = p_cheque_number,
        bank_name = p_bank_name,
        cheque_date = p_cheque_date,
        amount = p_amount,
        notes = p_notes,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = p_pdc_id;

    SELECT row_to_json(p) INTO v_saved FROM busy_ufo_pdcs p WHERE id = p_pdc_id;
    RETURN jsonb_build_object('success', true, 'data', v_saved);
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$ LANGUAGE plpgsql;


-- 3. Atomic Delete PDC RPC (Refuses deletion of CLEARED or Journal-linked PDCs to preserve accounting integrity)
CREATE OR REPLACE FUNCTION delete_pdc_rpc(
    p_pdc_id VARCHAR,
    p_company_id VARCHAR
) RETURNS JSONB AS $$
DECLARE
    v_pdc RECORD;
BEGIN
    SELECT * INTO v_pdc FROM busy_ufo_pdcs WHERE id = p_pdc_id AND company_id = p_company_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'PDC record not found.');
    END IF;

    IF v_pdc.status = 'CLEARED' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Cannot delete a CLEARED cheque. Bounced/reversal journal entries exist. Reverse the transaction first to maintain accounting integrity.');
    END IF;

    -- If linked to a journal entry, prevent deletion to preserve ledger history
    IF v_pdc.linked_journal_id IS NOT NULL AND v_pdc.linked_journal_id <> '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Cannot delete PDC with linked journal entry ' || v_pdc.linked_journal_id || '. Accounting audit trail must be preserved.');
    END IF;

    DELETE FROM busy_ufo_pdcs WHERE id = p_pdc_id;
    RETURN jsonb_build_object('success', true, 'message', 'PDC deleted successfully');
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$ LANGUAGE plpgsql;


-- 4. Atomic Void / Delete Sale Invoice RPC (Safely reverses stock and customer balance atomically)
CREATE OR REPLACE FUNCTION void_sale_invoice_rpc(
    p_invoice_id VARCHAR,
    p_company_id VARCHAR,
    p_request_id VARCHAR DEFAULT ''
) RETURNS JSONB AS $$
DECLARE
    v_sale RECORD;
    v_item RECORD;
BEGIN
    SELECT * INTO v_sale FROM busy_ufo_sales WHERE id = p_invoice_id AND company_id = p_company_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Sale invoice not found or company mismatch.');
    END IF;

    -- 1. Reverse Stock Effect (Restore items into inventory)
    FOR v_item IN SELECT product_id, quantity FROM busy_ufo_sale_items WHERE invoice_id = p_invoice_id LOOP
        IF v_item.product_id IS NOT NULL THEN
            UPDATE busy_ufo_products
            SET current_stock = current_stock + v_item.quantity,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = v_item.product_id;
        END IF;
    END LOOP;

    -- 2. Reverse Customer Outstanding Balance
    IF v_sale.customer_id IS NOT NULL AND COALESCE(v_sale.due_amount, 0) > 0 THEN
        UPDATE busy_ufo_customers
        SET current_balance = current_balance - v_sale.due_amount,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = v_sale.customer_id;
    END IF;

    -- 3. Unlink customer receipts pointing to this invoice
    UPDATE busy_ufo_customer_receipts SET invoice_id = NULL WHERE invoice_id = p_invoice_id;

    -- 4. Delete child items and invoice row
    DELETE FROM busy_ufo_sale_items WHERE invoice_id = p_invoice_id;
    DELETE FROM busy_ufo_sales WHERE id = p_invoice_id;

    RETURN jsonb_build_object('success', true, 'message', 'Sale invoice voided and stock/balance restored successfully.');
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$ LANGUAGE plpgsql;


-- 5. Atomic Void / Delete Purchase Invoice RPC (Safely reverses stock and supplier balance atomically)
CREATE OR REPLACE FUNCTION void_purchase_invoice_rpc(
    p_purchase_id VARCHAR,
    p_company_id VARCHAR,
    p_request_id VARCHAR DEFAULT ''
) RETURNS JSONB AS $$
DECLARE
    v_pur RECORD;
    v_item RECORD;
    v_prod_stock NUMERIC;
    v_allow_negative BOOLEAN := FALSE;
BEGIN
    SELECT * INTO v_pur FROM busy_ufo_purchases WHERE id = p_purchase_id AND company_id = p_company_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Purchase bill not found or company mismatch.');
    END IF;

    SELECT COALESCE(allow_negative_stock, FALSE) INTO v_allow_negative FROM busy_ufo_settings LIMIT 1;

    -- 1. Check stock availability before reversing purchase (if negative stock is disallowed)
    IF NOT v_allow_negative THEN
        FOR v_item IN SELECT product_id, quantity FROM busy_ufo_purchase_items WHERE purchase_id = p_purchase_id LOOP
            IF v_item.product_id IS NOT NULL THEN
                SELECT current_stock INTO v_prod_stock FROM busy_ufo_products WHERE id = v_item.product_id FOR UPDATE;
                IF (v_prod_stock - v_item.quantity) < 0 THEN
                    RETURN jsonb_build_object('success', false, 'error', 'Cannot void purchase: Product has already been sold or stock would become negative.');
                END IF;
            END IF;
        END LOOP;
    END IF;

    -- 2. Reverse Stock Effect (Deduct added items from inventory)
    FOR v_item IN SELECT product_id, quantity FROM busy_ufo_purchase_items WHERE purchase_id = p_purchase_id LOOP
        IF v_item.product_id IS NOT NULL THEN
            UPDATE busy_ufo_products
            SET current_stock = current_stock - v_item.quantity,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = v_item.product_id;
        END IF;
    END LOOP;

    -- 3. Reverse Supplier Payable Balance
    IF v_pur.supplier_id IS NOT NULL AND COALESCE(v_pur.due_amount, 0) > 0 THEN
        UPDATE busy_ufo_suppliers
        SET current_balance = current_balance - v_pur.due_amount,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = v_pur.supplier_id;
    END IF;

    -- 4. Unlink payments pointing to this purchase
    UPDATE busy_ufo_supplier_payments SET purchase_id = NULL WHERE purchase_id = p_purchase_id;

    -- 5. Delete child items and purchase bill
    DELETE FROM busy_ufo_purchase_items WHERE purchase_id = p_purchase_id;
    DELETE FROM busy_ufo_purchases WHERE id = p_purchase_id;

    RETURN jsonb_build_object('success', true, 'message', 'Purchase bill voided and stock/payable balance reversed successfully.');
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$ LANGUAGE plpgsql;
