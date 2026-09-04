-- ============================================================
-- CIEN ERP — FINAL PHASE 3 PRODUCTION SAFETY MIGRATION
-- File: migrations/20260904_final_phase3_production_safety.sql
-- Strictly forward-only, backward-compatible, non-destructive.
-- ============================================================

-- 1. Void Sale Invoice RPC (Authoritative atomic reversal of stock, customer balance, linked receipts, and journals)
CREATE OR REPLACE FUNCTION void_sale_invoice_rpc(
    p_invoice_id VARCHAR,
    p_company_id VARCHAR,
    p_request_id VARCHAR DEFAULT ''
) RETURNS JSONB AS $$
DECLARE
    v_sale RECORD;
    v_item RECORD;
BEGIN
    IF p_invoice_id IS NULL OR p_invoice_id = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invoice ID is required.');
    END IF;

    SELECT * INTO v_sale FROM busy_ufo_sales 
    WHERE id = p_invoice_id AND company_id = p_company_id FOR UPDATE;
    
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
        SET current_balance = GREATEST(0, current_balance - v_sale.due_amount),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = v_sale.customer_id AND company_id = p_company_id;
    END IF;

    -- 3. Unlink customer receipts pointing to this invoice
    UPDATE busy_ufo_customer_receipts 
    SET invoice_id = NULL 
    WHERE invoice_id = p_invoice_id AND company_id = p_company_id;

    -- 4. Reverse/Delete any linked journal entries for this sale
    DELETE FROM busy_ufo_journal_lines 
    WHERE journal_id IN (
        SELECT id FROM busy_ufo_journal_entries 
        WHERE company_id = p_company_id AND (reference_id = p_invoice_id OR voucher_no = v_sale.invoice_number)
    );
    DELETE FROM busy_ufo_journal_entries 
    WHERE company_id = p_company_id AND (reference_id = p_invoice_id OR voucher_no = v_sale.invoice_number);

    -- 5. Delete child items and invoice row
    DELETE FROM busy_ufo_sale_items WHERE invoice_id = p_invoice_id;
    DELETE FROM busy_ufo_sales WHERE id = p_invoice_id AND company_id = p_company_id;

    RETURN jsonb_build_object('success', true, 'message', 'Sale invoice voided and stock/customer balance reversed successfully.');
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$ LANGUAGE plpgsql;


-- 2. Void Purchase Invoice RPC (Authoritative atomic reversal of stock, supplier balance, linked payments, and journals)
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
    IF p_purchase_id IS NULL OR p_purchase_id = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Purchase ID is required.');
    END IF;

    SELECT * INTO v_pur FROM busy_ufo_purchases 
    WHERE id = p_purchase_id AND company_id = p_company_id FOR UPDATE;
    
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
                    RETURN jsonb_build_object('success', false, 'error', 'Cannot void purchase: Product stock would become negative.');
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
        SET current_balance = GREATEST(0, current_balance - v_pur.due_amount),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = v_pur.supplier_id AND company_id = p_company_id;
    END IF;

    -- 4. Unlink payments pointing to this purchase
    UPDATE busy_ufo_supplier_payments 
    SET purchase_id = NULL 
    WHERE purchase_id = p_purchase_id AND company_id = p_company_id;

    -- 5. Reverse/Delete any linked journal entries for this purchase
    DELETE FROM busy_ufo_journal_lines 
    WHERE journal_id IN (
        SELECT id FROM busy_ufo_journal_entries 
        WHERE company_id = p_company_id AND (reference_id = p_purchase_id OR voucher_no = v_pur.purchase_number)
    );
    DELETE FROM busy_ufo_journal_entries 
    WHERE company_id = p_company_id AND (reference_id = p_purchase_id OR voucher_no = v_pur.purchase_number);

    -- 6. Delete child items and purchase bill
    DELETE FROM busy_ufo_purchase_items WHERE purchase_id = p_purchase_id;
    DELETE FROM busy_ufo_purchases WHERE id = p_purchase_id AND company_id = p_company_id;

    RETURN jsonb_build_object('success', true, 'message', 'Purchase bill voided and stock/supplier balance reversed successfully.');
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$ LANGUAGE plpgsql;


-- 3. Void / Cancel PDC RPC (Authoritative atomic PDC cancellation and reversal)
CREATE OR REPLACE FUNCTION void_pdc_rpc(
    p_pdc_id VARCHAR,
    p_company_id VARCHAR,
    p_request_id VARCHAR DEFAULT '',
    p_reason TEXT DEFAULT ''
) RETURNS JSONB AS $$
DECLARE
    v_pdc RECORD;
BEGIN
    IF p_pdc_id IS NULL OR p_pdc_id = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'PDC ID is required.');
    END IF;

    SELECT * INTO v_pdc FROM busy_ufo_pdcs 
    WHERE id = p_pdc_id AND company_id = p_company_id FOR UPDATE;
    
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'PDC record not found or company mismatch.');
    END IF;

    -- If already cancelled/deleted
    IF v_pdc.status = 'CANCELLED' THEN
        RETURN jsonb_build_object('success', true, 'message', 'PDC is already cancelled.');
    END IF;

    -- If cheque was CLEARED, atomically reverse accounting balances and linked journal
    IF v_pdc.status = 'CLEARED' THEN
        IF v_pdc.type = 'RECEIVED' AND v_pdc.party_id IS NOT NULL THEN
            UPDATE busy_ufo_customers
            SET current_balance = current_balance + v_pdc.amount,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = v_pdc.party_id AND company_id = p_company_id;
        ELSIF v_pdc.type = 'ISSUED' AND v_pdc.party_id IS NOT NULL THEN
            UPDATE busy_ufo_suppliers
            SET current_balance = current_balance + v_pdc.amount,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = v_pdc.party_id AND company_id = p_company_id;
        END IF;

        IF v_pdc.linked_journal_id IS NOT NULL AND v_pdc.linked_journal_id <> '' THEN
            DELETE FROM busy_ufo_journal_lines 
            WHERE journal_id = v_pdc.linked_journal_id OR entry_id = v_pdc.linked_journal_id;
            DELETE FROM busy_ufo_journal_entries 
            WHERE id = v_pdc.linked_journal_id AND company_id = p_company_id;
        END IF;
    END IF;

    -- Atomically delete the PDC record
    DELETE FROM busy_ufo_pdcs WHERE id = p_pdc_id AND company_id = p_company_id;

    RETURN jsonb_build_object('success', true, 'message', 'PDC cancelled and deleted successfully.');
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$ LANGUAGE plpgsql;

-- Alias delete_pdc_rpc to void_pdc_rpc for backward compatibility
CREATE OR REPLACE FUNCTION delete_pdc_rpc(
    p_pdc_id VARCHAR,
    p_company_id VARCHAR,
    p_request_id VARCHAR DEFAULT ''
) RETURNS JSONB AS $$
BEGIN
    RETURN void_pdc_rpc(p_pdc_id, p_company_id, p_request_id, 'User deleted PDC');
END;
$$ LANGUAGE plpgsql;


-- 4. Update PDC RPC with Full Request ID Idempotency
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
    v_dup RECORD;
    v_saved JSONB;
BEGIN
    -- Check idempotency: If this request_id was already committed
    IF p_request_id IS NOT NULL AND p_request_id <> '' THEN
        SELECT * INTO v_dup FROM busy_ufo_pdcs 
        WHERE company_id = p_company_id AND request_id = p_request_id LIMIT 1;
        
        IF FOUND THEN
            SELECT row_to_json(p) INTO v_saved FROM busy_ufo_pdcs p WHERE id = v_dup.id;
            RETURN jsonb_build_object('success', true, 'is_duplicate', true, 'data', v_saved);
        END IF;
    END IF;

    SELECT * INTO v_pdc FROM busy_ufo_pdcs 
    WHERE id = p_pdc_id AND company_id = p_company_id FOR UPDATE;
    
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'PDC record not found or company mismatch.');
    END IF;

    IF v_pdc.status = 'CLEARED' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Cannot edit a CLEARED cheque. Bounce/reverse it first.');
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
        request_id = COALESCE(NULLIF(p_request_id, ''), request_id),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = p_pdc_id AND company_id = p_company_id;

    SELECT row_to_json(p) INTO v_saved FROM busy_ufo_pdcs p WHERE id = p_pdc_id;
    RETURN jsonb_build_object('success', true, 'data', v_saved);
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$ LANGUAGE plpgsql;


-- 5. Void Customer Receipt RPC (Authoritative atomic reversal of customer balance and linked journals)
CREATE OR REPLACE FUNCTION void_customer_receipt_rpc(
    p_receipt_id VARCHAR,
    p_company_id VARCHAR,
    p_request_id VARCHAR DEFAULT ''
) RETURNS JSONB AS $$
DECLARE
    v_rec RECORD;
BEGIN
    IF p_receipt_id IS NULL OR p_receipt_id = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Receipt ID is required.');
    END IF;

    SELECT * INTO v_rec FROM busy_ufo_customer_receipts 
    WHERE id = p_receipt_id AND company_id = p_company_id FOR UPDATE;
    
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Customer receipt not found or company mismatch.');
    END IF;

    -- 1. Reverse Customer Outstanding Balance (Restore debtor debt)
    IF v_rec.customer_id IS NOT NULL AND COALESCE(v_rec.amount, 0) > 0 THEN
        UPDATE busy_ufo_customers
        SET current_balance = current_balance + v_rec.amount,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = v_rec.customer_id AND company_id = p_company_id;
    END IF;

    -- 2. If receipt was linked to a sale invoice, restore invoice due amount
    IF v_rec.invoice_id IS NOT NULL THEN
        UPDATE busy_ufo_sales
        SET paid_amount = GREATEST(0, paid_amount - v_rec.amount),
            due_amount = due_amount + v_rec.amount,
            payment_status = CASE 
                WHEN (paid_amount - v_rec.amount) <= 0 THEN 'UNPAID'
                ELSE 'PARTIAL'
            END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = v_rec.invoice_id AND company_id = p_company_id;
    END IF;

    -- 3. Reverse/Delete any linked journal entry
    DELETE FROM busy_ufo_journal_lines 
    WHERE journal_id IN (
        SELECT id FROM busy_ufo_journal_entries 
        WHERE company_id = p_company_id AND (reference_id = p_receipt_id OR voucher_no = v_rec.receipt_number)
    );
    DELETE FROM busy_ufo_journal_entries 
    WHERE company_id = p_company_id AND (reference_id = p_receipt_id OR voucher_no = v_rec.receipt_number);

    -- 4. Delete the receipt record
    DELETE FROM busy_ufo_customer_receipts WHERE id = p_receipt_id AND company_id = p_company_id;

    RETURN jsonb_build_object('success', true, 'message', 'Customer receipt voided and customer balance restored successfully.');
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$ LANGUAGE plpgsql;


-- 6. Void Supplier Payment RPC (Authoritative atomic reversal of supplier balance and linked journals)
CREATE OR REPLACE FUNCTION void_supplier_payment_rpc(
    p_payment_id VARCHAR,
    p_company_id VARCHAR,
    p_request_id VARCHAR DEFAULT ''
) RETURNS JSONB AS $$
DECLARE
    v_pay RECORD;
BEGIN
    IF p_payment_id IS NULL OR p_payment_id = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Payment ID is required.');
    END IF;

    SELECT * INTO v_pay FROM busy_ufo_supplier_payments 
    WHERE id = p_payment_id AND company_id = p_company_id FOR UPDATE;
    
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Supplier payment not found or company mismatch.');
    END IF;

    -- 1. Reverse Supplier Payable Balance (Restore creditor debt)
    IF v_pay.supplier_id IS NOT NULL AND COALESCE(v_pay.amount, 0) > 0 THEN
        UPDATE busy_ufo_suppliers
        SET current_balance = current_balance + v_pay.amount,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = v_pay.supplier_id AND company_id = p_company_id;
    END IF;

    -- 2. If payment was linked to a purchase bill, restore purchase bill due amount
    IF v_pay.purchase_id IS NOT NULL THEN
        UPDATE busy_ufo_purchases
        SET paid_amount = GREATEST(0, paid_amount - v_pay.amount),
            due_amount = due_amount + v_pay.amount,
            payment_status = CASE 
                WHEN (paid_amount - v_pay.amount) <= 0 THEN 'UNPAID'
                ELSE 'PARTIAL'
            END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = v_pay.purchase_id AND company_id = p_company_id;
    END IF;

    -- 3. Reverse/Delete any linked journal entry
    DELETE FROM busy_ufo_journal_lines 
    WHERE journal_id IN (
        SELECT id FROM busy_ufo_journal_entries 
        WHERE company_id = p_company_id AND (reference_id = p_payment_id OR voucher_no = v_pay.payment_number)
    );
    DELETE FROM busy_ufo_journal_entries 
    WHERE company_id = p_company_id AND (reference_id = p_payment_id OR voucher_no = v_pay.payment_number);

    -- 4. Delete the payment record
    DELETE FROM busy_ufo_supplier_payments WHERE id = p_payment_id AND company_id = p_company_id;

    RETURN jsonb_build_object('success', true, 'message', 'Supplier payment voided and supplier balance restored successfully.');
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$ LANGUAGE plpgsql;


-- 7. Save Journal Entry RPC (Atomic create/edit with Debit = Credit balance validation)
CREATE OR REPLACE FUNCTION save_journal_entry_rpc(
    p_request_id VARCHAR,
    p_company_id VARCHAR,
    p_entry_id VARCHAR,
    p_voucher_no VARCHAR,
    p_voucher_type VARCHAR,
    p_voucher_date DATE,
    p_narration TEXT,
    p_lines JSONB
) RETURNS JSONB AS $$
DECLARE
    v_existing JSONB;
    v_line JSONB;
    v_total_debit NUMERIC(12,2) := 0.00;
    v_total_credit NUMERIC(12,2) := 0.00;
    v_line_debit NUMERIC(12,2);
    v_line_credit NUMERIC(12,2);
    v_id VARCHAR(100);
    v_saved JSONB;
BEGIN
    IF p_company_id IS NULL OR p_company_id = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Company ID is required.');
    END IF;

    -- 1. Idempotency Check: if request_id already exists in journal entries
    IF p_request_id IS NOT NULL AND p_request_id <> '' THEN
        SELECT row_to_json(j) INTO v_existing 
        FROM busy_ufo_journal_entries j 
        WHERE request_id = p_request_id AND company_id = p_company_id LIMIT 1;
        
        IF v_existing IS NOT NULL THEN
            RETURN jsonb_build_object('success', true, 'is_duplicate', true, 'data', v_existing);
        END IF;
    END IF;

    -- 2. Validate Lines existence
    IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 2 THEN
        RETURN jsonb_build_object('success', false, 'error', 'A double-entry journal voucher requires at least two lines.');
    END IF;

    -- 3. Calculate and Validate Total Debit = Total Credit
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
        v_line_debit := COALESCE((v_line->>'debit')::NUMERIC, 0.00);
        v_line_credit := COALESCE((v_line->>'credit')::NUMERIC, 0.00);
        v_total_debit := v_total_debit + v_line_debit;
        v_total_credit := v_total_credit + v_line_credit;
    END LOOP;

    IF ABS(v_total_debit - v_total_credit) > 0.009 THEN
        RETURN jsonb_build_object('success', false, 'error', 
            'Unbalanced Journal Entry: Total Debit (' || v_total_debit || ') must equal Total Credit (' || v_total_credit || '). Difference: ' || ABS(v_total_debit - v_total_credit));
    END IF;

    IF v_total_debit <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Journal total amount must be greater than zero.');
    END IF;

    -- 4. Check if editing an existing journal entry
    IF p_entry_id IS NOT NULL AND p_entry_id <> '' THEN
        SELECT id INTO v_id FROM busy_ufo_journal_entries 
        WHERE id = p_entry_id AND company_id = p_company_id FOR UPDATE;
        
        IF NOT FOUND THEN
            v_id := p_entry_id;
            INSERT INTO busy_ufo_journal_entries (
                id, request_id, company_id, voucher_no, entry_number, voucher_type,
                voucher_date, date, narration, notes, debit_total, credit_total, created_at
            ) VALUES (
                v_id, p_request_id, p_company_id, p_voucher_no, p_voucher_no, COALESCE(p_voucher_type, 'JOURNAL'),
                COALESCE(p_voucher_date, CURRENT_DATE), COALESCE(p_voucher_date, CURRENT_DATE),
                p_narration, p_narration, v_total_debit, v_total_credit, CURRENT_TIMESTAMP
            );
        ELSE
            UPDATE busy_ufo_journal_entries
            SET voucher_no = p_voucher_no,
                entry_number = p_voucher_no,
                voucher_type = COALESCE(p_voucher_type, voucher_type),
                voucher_date = COALESCE(p_voucher_date, voucher_date),
                date = COALESCE(p_voucher_date, date),
                narration = p_narration,
                notes = p_narration,
                debit_total = v_total_debit,
                credit_total = v_total_credit,
                request_id = COALESCE(NULLIF(p_request_id, ''), request_id)
            WHERE id = v_id AND company_id = p_company_id;

            -- Atomic replacement of journal lines
            DELETE FROM busy_ufo_journal_lines WHERE entry_id = v_id OR journal_id = v_id;
        END IF;
    ELSE
        v_id := 'jrn-' || EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)::BIGINT || '-' || floor(random() * 1000)::TEXT;
        INSERT INTO busy_ufo_journal_entries (
            id, request_id, company_id, voucher_no, entry_number, voucher_type,
            voucher_date, date, narration, notes, debit_total, credit_total, created_at
        ) VALUES (
            v_id, p_request_id, p_company_id, p_voucher_no, p_voucher_no, COALESCE(p_voucher_type, 'JOURNAL'),
            COALESCE(p_voucher_date, CURRENT_DATE), COALESCE(p_voucher_date, CURRENT_DATE),
            p_narration, p_narration, v_total_debit, v_total_credit, CURRENT_TIMESTAMP
        );
    END IF;

    -- 5. Insert Journal Lines atomically
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
        INSERT INTO busy_ufo_journal_lines (
            id, journal_id, entry_id, ledger_id, ledger_name,
            account_group, debit, credit, particulars
        ) VALUES (
            gen_random_uuid(),
            v_id,
            v_id,
            v_line->>'ledger_id',
            v_line->>'ledger_name',
            COALESCE(v_line->>'account_group', 'General'),
            COALESCE((v_line->>'debit')::NUMERIC, 0.00),
            COALESCE((v_line->>'credit')::NUMERIC, 0.00),
            v_line->>'particulars'
        );
    END LOOP;

    SELECT row_to_json(j) INTO v_saved FROM busy_ufo_journal_entries j WHERE id = v_id;
    RETURN jsonb_build_object('success', true, 'data', v_saved);
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$ LANGUAGE plpgsql;


-- 8. Void Sale Return RPC (Atomic reversal of inventory and customer balance)
CREATE OR REPLACE FUNCTION void_sale_return_rpc(
    p_return_id VARCHAR,
    p_company_id VARCHAR,
    p_request_id VARCHAR DEFAULT ''
) RETURNS JSONB AS $$
DECLARE
    v_ret RECORD;
    v_item RECORD;
    v_prod_stock NUMERIC;
    v_allow_negative BOOLEAN := FALSE;
BEGIN
    IF p_return_id IS NULL OR p_return_id = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Return ID is required.');
    END IF;

    SELECT * INTO v_ret FROM busy_ufo_sales_returns 
    WHERE id = p_return_id AND company_id = p_company_id FOR UPDATE;
    
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Sales return not found or company mismatch.');
    END IF;

    SELECT COALESCE(allow_negative_stock, FALSE) INTO v_allow_negative FROM busy_ufo_settings LIMIT 1;

    -- Deduct stock that was previously returned into inventory
    IF NOT v_allow_negative THEN
        FOR v_item IN SELECT product_id, quantity FROM busy_ufo_sales_return_items WHERE return_id = p_return_id LOOP
            IF v_item.product_id IS NOT NULL THEN
                SELECT current_stock INTO v_prod_stock FROM busy_ufo_products WHERE id = v_item.product_id FOR UPDATE;
                IF (v_prod_stock - v_item.quantity) < 0 THEN
                    RETURN jsonb_build_object('success', false, 'error', 'Cannot void return: Product stock would become negative.');
                END IF;
            END IF;
        END LOOP;
    END IF;

    FOR v_item IN SELECT product_id, quantity FROM busy_ufo_sales_return_items WHERE return_id = p_return_id LOOP
        IF v_item.product_id IS NOT NULL THEN
            UPDATE busy_ufo_products
            SET current_stock = current_stock - v_item.quantity,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = v_item.product_id;
        END IF;
    END LOOP;

    -- If customer had received credit, restore customer outstanding balance
    IF v_ret.customer_id IS NOT NULL AND COALESCE(v_ret.grand_total, 0) > 0 AND v_ret.type = 'CREDIT' THEN
        UPDATE busy_ufo_customers
        SET current_balance = current_balance + v_ret.grand_total,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = v_ret.customer_id AND company_id = p_company_id;
    END IF;

    DELETE FROM busy_ufo_sales_return_items WHERE return_id = p_return_id;
    DELETE FROM busy_ufo_sales_returns WHERE id = p_return_id AND company_id = p_company_id;

    RETURN jsonb_build_object('success', true, 'message', 'Sales return voided and inventory/customer balance adjusted.');
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$ LANGUAGE plpgsql;


-- 9. Void Purchase Return RPC (Atomic reversal of inventory and supplier balance)
CREATE OR REPLACE FUNCTION void_purchase_return_rpc(
    p_return_id VARCHAR,
    p_company_id VARCHAR,
    p_request_id VARCHAR DEFAULT ''
) RETURNS JSONB AS $$
DECLARE
    v_ret RECORD;
    v_item RECORD;
BEGIN
    IF p_return_id IS NULL OR p_return_id = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Return ID is required.');
    END IF;

    SELECT * INTO v_ret FROM busy_ufo_purchase_returns 
    WHERE id = p_return_id AND company_id = p_company_id FOR UPDATE;
    
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Purchase return not found or company mismatch.');
    END IF;

    -- Restore stock that was returned to supplier
    FOR v_item IN SELECT product_id, quantity FROM busy_ufo_purchase_return_items WHERE return_id = p_return_id LOOP
        IF v_item.product_id IS NOT NULL THEN
            UPDATE busy_ufo_products
            SET current_stock = current_stock + v_item.quantity,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = v_item.product_id;
        END IF;
    END LOOP;

    -- If supplier balance was credited/deducted, restore supplier debt
    IF v_ret.supplier_id IS NOT NULL AND COALESCE(v_ret.grand_total, 0) > 0 AND v_ret.type = 'CREDIT' THEN
        UPDATE busy_ufo_suppliers
        SET current_balance = current_balance + v_ret.grand_total,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = v_ret.supplier_id AND company_id = p_company_id;
    END IF;

    DELETE FROM busy_ufo_purchase_return_items WHERE return_id = p_return_id;
    DELETE FROM busy_ufo_purchase_returns WHERE id = p_return_id AND company_id = p_company_id;

    RETURN jsonb_build_object('success', true, 'message', 'Purchase return voided and inventory/supplier balance adjusted.');
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$ LANGUAGE plpgsql;
