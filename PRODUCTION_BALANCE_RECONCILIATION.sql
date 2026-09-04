-- ============================================================
-- PRODUCTION BALANCE RECONCILIATION SCRIPT (READ-ONLY)
-- CIEN ERP — Live Supabase Production Safety Audit
-- ============================================================
-- ⚠️ ABSOLUTE PRODUCTION SAFETY RULE:
-- This script is strictly 100% READ-ONLY.
-- NO UPDATE, NO DELETE, NO INSERT, NO DROP, NO TRUNCATE, NO ALTER.
-- It diagnoses and reports discrepancies between stored party balances
-- and the underlying transactional ledger history.
-- ============================================================

-- ------------------------------------------------------------
-- 1. SUPPLIER PAYABLE BALANCE RECONCILIATION AUDIT
-- Compares stored current_balance against:
-- Opening Balance + Total Purchases - Total Payments - Total Purchase Returns
-- Grouped strictly by (company_id, supplier_id).
-- ------------------------------------------------------------

WITH supplier_purchases AS (
    SELECT 
        company_id,
        supplier_id,
        COUNT(id) AS purchase_count,
        COALESCE(SUM(grand_total), 0) AS total_purchased,
        COALESCE(SUM(CASE WHEN purchase_type = 'CREDIT' THEN grand_total ELSE due_amount END), 0) AS total_credit_purchases,
        COALESCE(SUM(paid_amount), 0) AS total_invoice_paid_amount,
        COALESCE(SUM(due_amount), 0) AS total_due_amount
    FROM busy_ufo_purchases
    WHERE supplier_id IS NOT NULL AND supplier_id <> ''
    GROUP BY company_id, supplier_id
),
supplier_payments AS (
    SELECT 
        company_id,
        supplier_id,
        COUNT(id) AS payment_count,
        COALESCE(SUM(amount), 0) AS total_payments
    FROM busy_ufo_supplier_payments
    WHERE supplier_id IS NOT NULL AND supplier_id <> ''
    GROUP BY company_id, supplier_id
),
supplier_returns AS (
    SELECT 
        company_id,
        supplier_id,
        COUNT(id) AS return_count,
        COALESCE(SUM(grand_total), 0) AS total_returns
    FROM busy_ufo_purchase_returns
    WHERE supplier_id IS NOT NULL AND supplier_id <> '' AND (type = 'CREDIT' OR type IS NULL)
    GROUP BY company_id, supplier_id
)
SELECT 
    'SUPPLIER RECONCILIATION' AS audit_type,
    s.company_id,
    s.id AS supplier_id,
    s.code AS supplier_code,
    s.name AS supplier_name,
    COALESCE(s.opening_balance, 0) AS opening_balance,
    COALESCE(sp.total_purchased, 0) AS total_purchased,
    COALESCE(sp.total_due_amount, 0) AS total_invoice_due,
    COALESCE(pay.total_payments, 0) AS total_payments,
    COALESCE(sr.total_returns, 0) AS total_returns,
    COALESCE(s.current_balance, 0) AS stored_payable_balance,
    -- Standard accounting formula: Opening + Billed - Paid - Returns
    (COALESCE(s.opening_balance, 0) + COALESCE(sp.total_purchased, 0) - COALESCE(pay.total_payments, 0) - COALESCE(sr.total_returns, 0)) AS calculated_ledger_balance,
    -- Variance between stored balance and ledger balance
    (COALESCE(s.current_balance, 0) - (COALESCE(s.opening_balance, 0) + COALESCE(sp.total_purchased, 0) - COALESCE(pay.total_payments, 0) - COALESCE(sr.total_returns, 0))) AS variance,
    CASE 
        WHEN ABS(COALESCE(s.current_balance, 0) - (COALESCE(s.opening_balance, 0) + COALESCE(sp.total_purchased, 0) - COALESCE(pay.total_payments, 0) - COALESCE(sr.total_returns, 0))) < 0.01 
        THEN 'RECONCILED'
        ELSE 'DISCREPANCY_DETECTED'
    END AS status
FROM busy_ufo_suppliers s
LEFT JOIN supplier_purchases sp ON s.id = sp.supplier_id AND s.company_id = sp.company_id
LEFT JOIN supplier_payments pay ON s.id = pay.supplier_id AND s.company_id = pay.company_id
LEFT JOIN supplier_returns sr ON s.id = sr.supplier_id AND s.company_id = sr.company_id
ORDER BY s.company_id, ABS(COALESCE(s.current_balance, 0) - (COALESCE(s.opening_balance, 0) + COALESCE(sp.total_purchased, 0) - COALESCE(pay.total_payments, 0) - COALESCE(sr.total_returns, 0))) DESC;


-- ------------------------------------------------------------
-- 2. CUSTOMER RECEIVABLE BALANCE RECONCILIATION AUDIT
-- Compares stored current_balance against:
-- Opening Balance + Total Sales - Total Receipts - Total Sales Returns
-- Grouped strictly by (company_id, customer_id).
-- ------------------------------------------------------------

WITH customer_sales AS (
    SELECT 
        company_id,
        customer_id,
        COUNT(id) AS sale_count,
        COALESCE(SUM(grand_total), 0) AS total_sales,
        COALESCE(SUM(CASE WHEN sale_type = 'CREDIT' THEN grand_total ELSE due_amount END), 0) AS total_credit_sales,
        COALESCE(SUM(paid_amount), 0) AS total_invoice_paid_amount,
        COALESCE(SUM(due_amount), 0) AS total_due_amount
    FROM busy_ufo_sales
    WHERE customer_id IS NOT NULL AND customer_id <> ''
    GROUP BY company_id, customer_id
),
customer_receipts AS (
    SELECT 
        company_id,
        customer_id,
        COUNT(id) AS receipt_count,
        COALESCE(SUM(amount), 0) AS total_receipts
    FROM busy_ufo_customer_receipts
    WHERE customer_id IS NOT NULL AND customer_id <> ''
    GROUP BY company_id, customer_id
),
customer_returns AS (
    SELECT 
        company_id,
        customer_id,
        COUNT(id) AS return_count,
        COALESCE(SUM(grand_total), 0) AS total_returns
    FROM busy_ufo_sales_returns
    WHERE customer_id IS NOT NULL AND customer_id <> '' AND (type = 'CREDIT' OR type IS NULL)
    GROUP BY company_id, customer_id
)
SELECT 
    'CUSTOMER RECONCILIATION' AS audit_type,
    c.company_id,
    c.id AS customer_id,
    c.code AS customer_code,
    c.name AS customer_name,
    COALESCE(c.opening_balance, 0) AS opening_balance,
    COALESCE(cs.total_sales, 0) AS total_sales,
    COALESCE(cs.total_due_amount, 0) AS total_invoice_due,
    COALESCE(rec.total_receipts, 0) AS total_receipts,
    COALESCE(cr.total_returns, 0) AS total_returns,
    COALESCE(c.current_balance, 0) AS stored_receivable_balance,
    -- Standard accounting formula: Opening + Billed - Received - Returns
    (COALESCE(c.opening_balance, 0) + COALESCE(cs.total_sales, 0) - COALESCE(rec.total_receipts, 0) - COALESCE(cr.total_returns, 0)) AS calculated_ledger_balance,
    -- Variance between stored balance and ledger balance
    (COALESCE(c.current_balance, 0) - (COALESCE(c.opening_balance, 0) + COALESCE(cs.total_sales, 0) - COALESCE(rec.total_receipts, 0) - COALESCE(cr.total_returns, 0))) AS variance,
    CASE 
        WHEN ABS(COALESCE(c.current_balance, 0) - (COALESCE(c.opening_balance, 0) + COALESCE(cs.total_sales, 0) - COALESCE(rec.total_receipts, 0) - COALESCE(cr.total_returns, 0))) < 0.01 
        THEN 'RECONCILED'
        ELSE 'DISCREPANCY_DETECTED'
    END AS status
FROM busy_ufo_customers c
LEFT JOIN customer_sales cs ON c.id = cs.customer_id AND c.company_id = cs.company_id
LEFT JOIN customer_receipts rec ON c.id = rec.customer_id AND c.company_id = rec.company_id
LEFT JOIN customer_returns cr ON c.id = cr.customer_id AND c.company_id = cr.company_id
ORDER BY c.company_id, ABS(COALESCE(c.current_balance, 0) - (COALESCE(c.opening_balance, 0) + COALESCE(cs.total_sales, 0) - COALESCE(rec.total_receipts, 0) - COALESCE(cr.total_returns, 0))) DESC;


-- ------------------------------------------------------------
-- 3. DETAILED CHRONOLOGICAL STATEMENT GENERATOR (SUPPLIER LEDGER TEMPLATE)
-- To inspect an individual supplier statement chronologically:
-- ------------------------------------------------------------

WITH supplier_statement_raw AS (
    -- Purchases (Debits to AP / Bill credits)
    SELECT 
        p.company_id,
        p.supplier_id,
        p.purchase_date AS trans_date,
        p.created_at,
        p.purchase_number AS voucher_number,
        'PURCHASE' AS voucher_type,
        'Purchase Bill (' || p.purchase_type || ')' AS description,
        p.grand_total AS billed_amount,
        0.00 AS payment_amount,
        0.00 AS return_amount
    FROM busy_ufo_purchases p

    UNION ALL

    -- Supplier Payments (Reductions of AP)
    SELECT 
        pm.company_id,
        pm.supplier_id,
        pm.date AS trans_date,
        pm.created_at,
        pm.payment_number AS voucher_number,
        'PAYMENT' AS voucher_type,
        'Payment Voucher (' || COALESCE(pm.payment_method, 'CASH') || ' ' || COALESCE(pm.reference_no, '') || ')' AS description,
        0.00 AS billed_amount,
        pm.amount AS payment_amount,
        0.00 AS return_amount
    FROM busy_ufo_supplier_payments pm

    UNION ALL

    -- Purchase Returns (Debit Notes / AP reductions)
    SELECT 
        pr.company_id,
        pr.supplier_id,
        pr.date AS trans_date,
        pr.created_at,
        pr.return_number AS voucher_number,
        'PURCHASE_RETURN' AS voucher_type,
        'Debit Note / Purchase Return' AS description,
        0.00 AS billed_amount,
        0.00 AS payment_amount,
        pr.grand_total AS return_amount
    FROM busy_ufo_purchase_returns pr
    WHERE pr.type = 'CREDIT' OR pr.type IS NULL
)
SELECT 
    s.company_id,
    s.name AS supplier_name,
    ssr.trans_date,
    ssr.voucher_number,
    ssr.voucher_type,
    ssr.description,
    ssr.billed_amount,
    ssr.payment_amount,
    ssr.return_amount,
    -- Running balance calculation in window
    (COALESCE(s.opening_balance, 0) + 
     SUM(ssr.billed_amount - ssr.payment_amount - ssr.return_amount) OVER (
         PARTITION BY ssr.company_id, ssr.supplier_id 
         ORDER BY ssr.trans_date ASC, ssr.created_at ASC
     )) AS running_payable_balance
FROM supplier_statement_raw ssr
JOIN busy_ufo_suppliers s ON ssr.supplier_id = s.id AND ssr.company_id = s.company_id
ORDER BY ssr.company_id, s.name, ssr.trans_date ASC, ssr.created_at ASC;
