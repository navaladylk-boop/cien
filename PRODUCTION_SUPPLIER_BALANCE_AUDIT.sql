-- ========================================================================================
-- CIEN ERP — PRODUCTION SUPPLIER & CUSTOMER BALANCE AUDIT (READ-ONLY DIAGNOSTIC)
-- ========================================================================================
-- IMPORTANT SAFETY GUARANTEE:
-- This script contains ONLY read-only SELECT queries.
-- It DOES NOT modify, update, delete, truncate, or repair any production data.
-- ========================================================================================

-- ========================================================================================
-- SECTION 1: TARGETED DIAGNOSTIC AUDIT FOR SUPPLIER "SI AUTO"
-- ========================================================================================

-- 1.1 Supplier Profile & Stored Balances
SELECT 
    id AS supplier_id,
    company_id,
    code AS supplier_code,
    name AS supplier_name,
    opening_balance,
    current_balance AS stored_payable_balance,
    created_at,
    updated_at
FROM busy_ufo_suppliers
WHERE UPPER(name) LIKE '%SI AUTO%' OR UPPER(name) LIKE '%S I AUTO%';

-- 1.2 All Purchase Invoices for "SI AUTO"
SELECT 
    p.id AS purchase_id,
    p.company_id,
    p.purchase_number,
    p.purchase_date,
    p.purchase_type,
    p.supplier_id,
    p.supplier_name,
    p.total_amount AS subtotal,
    p.overall_discount AS discount,
    p.grand_total,
    p.paid_amount AS purchase_paid_field,
    p.due_amount AS purchase_due_field,
    p.payment_status,
    p.notes,
    p.created_at
FROM busy_ufo_purchases p
WHERE p.supplier_id IN (
    SELECT id FROM busy_ufo_suppliers WHERE UPPER(name) LIKE '%SI AUTO%' OR UPPER(name) LIKE '%S I AUTO%'
)
ORDER BY p.purchase_date ASC, p.created_at ASC;

-- 1.3 All Purchase Items for "SI AUTO" Invoices
SELECT 
    pi.id AS item_id,
    pi.purchase_id,
    p.purchase_number,
    pi.product_id,
    pi.product_code,
    pi.product_name,
    pi.quantity,
    pi.unit_cost,
    pi.discount,
    pi.discount_type,
    pi.total AS line_total
FROM busy_ufo_purchase_items pi
JOIN busy_ufo_purchases p ON pi.purchase_id = p.id
WHERE p.supplier_id IN (
    SELECT id FROM busy_ufo_suppliers WHERE UPPER(name) LIKE '%SI AUTO%' OR UPPER(name) LIKE '%S I AUTO%'
)
ORDER BY p.purchase_date ASC, pi.id ASC;

-- 1.4 All Actual Supplier Payments for "SI AUTO" (Vouchers)
SELECT 
    sp.id AS payment_id,
    sp.company_id,
    sp.payment_number,
    sp.date AS payment_date,
    sp.supplier_id,
    sp.supplier_name,
    sp.amount AS payment_amount,
    sp.payment_method,
    sp.reference_no,
    sp.notes,
    sp.created_at
FROM busy_ufo_supplier_payments sp
WHERE sp.supplier_id IN (
    SELECT id FROM busy_ufo_suppliers WHERE UPPER(name) LIKE '%SI AUTO%' OR UPPER(name) LIKE '%S I AUTO%'
)
ORDER BY sp.date ASC, sp.created_at ASC;

-- 1.5 All Purchase Returns (Debit Notes) for "SI AUTO"
SELECT 
    pr.id AS return_id,
    pr.company_id,
    pr.return_number,
    pr.date AS return_date,
    pr.supplier_id,
    pr.supplier_name,
    pr.grand_total AS return_amount,
    pr.reason,
    pr.created_at
FROM busy_ufo_purchase_returns pr
WHERE pr.supplier_id IN (
    SELECT id FROM busy_ufo_suppliers WHERE UPPER(name) LIKE '%SI AUTO%' OR UPPER(name) LIKE '%S I AUTO%'
)
ORDER BY pr.date ASC, pr.created_at ASC;

-- 1.6 Exact Reconciliation & Variance Calculation for "SI AUTO"
WITH si_auto_supp AS (
    SELECT id, company_id, code, name, COALESCE(opening_balance, 0) AS ob, COALESCE(current_balance, 0) AS stored_bal
    FROM busy_ufo_suppliers
    WHERE UPPER(name) LIKE '%SI AUTO%' OR UPPER(name) LIKE '%S I AUTO%'
),
pur_summary AS (
    SELECT 
        supplier_id,
        company_id,
        COUNT(*) AS total_invoices_count,
        COALESCE(SUM(grand_total), 0) AS total_purchases_amount,
        COALESCE(SUM(paid_amount), 0) AS purchase_paid_sum,
        COALESCE(SUM(due_amount), 0) AS purchase_due_sum
    FROM busy_ufo_purchases
    GROUP BY supplier_id, company_id
),
pay_summary AS (
    SELECT 
        supplier_id,
        company_id,
        COUNT(*) AS total_payments_count,
        COALESCE(SUM(amount), 0) AS total_actual_payments_amount
    FROM busy_ufo_supplier_payments
    GROUP BY supplier_id, company_id
),
ret_summary AS (
    SELECT 
        supplier_id,
        company_id,
        COUNT(*) AS total_returns_count,
        COALESCE(SUM(grand_total), 0) AS total_returns_amount
    FROM busy_ufo_purchase_returns
    GROUP BY supplier_id, company_id
)
SELECT 
    s.company_id,
    s.id AS supplier_id,
    s.name AS supplier_name,
    s.ob AS opening_balance,
    COALESCE(ps.total_purchases_amount, 0) AS total_purchases,
    COALESCE(pays.total_actual_payments_amount, 0) AS total_payments_vouchers,
    COALESCE(rs.total_returns_amount, 0) AS total_returns,
    (s.ob + COALESCE(ps.total_purchases_amount, 0) - COALESCE(pays.total_actual_payments_amount, 0) - COALESCE(rs.total_returns_amount, 0)) AS mathematically_correct_balance,
    s.stored_bal AS stored_database_balance,
    (s.stored_bal - (s.ob + COALESCE(ps.total_purchases_amount, 0) - COALESCE(pays.total_actual_payments_amount, 0) - COALESCE(rs.total_returns_amount, 0))) AS variance,
    CASE 
        WHEN ABS(s.stored_bal - (s.ob + COALESCE(ps.total_purchases_amount, 0) - COALESCE(pays.total_actual_payments_amount, 0) - COALESCE(rs.total_returns_amount, 0))) < 0.01 
        THEN 'RECONCILED'
        ELSE 'HISTORICAL DATA MISMATCH DETECTED'
    END AS audit_status
FROM si_auto_supp s
LEFT JOIN pur_summary ps ON s.id = ps.supplier_id AND s.company_id = ps.company_id
LEFT JOIN pay_summary pays ON s.id = pays.supplier_id AND s.company_id = pays.company_id
LEFT JOIN ret_summary rs ON s.id = rs.supplier_id AND s.company_id = rs.company_id;


-- ========================================================================================
-- SECTION 2: GLOBAL PRODUCTION SUPPLIER LEDGER AUDIT (MULTI-COMPANY ISOLATED)
-- ========================================================================================

WITH all_supp AS (
    SELECT 
        id, 
        company_id, 
        code, 
        name, 
        COALESCE(opening_balance, 0) AS opening_bal, 
        COALESCE(current_balance, 0) AS stored_bal
    FROM busy_ufo_suppliers
),
all_pur AS (
    SELECT 
        supplier_id,
        company_id,
        COUNT(*) AS pur_count,
        COALESCE(SUM(grand_total), 0) AS total_purchases,
        COALESCE(SUM(CASE WHEN purchase_type = 'CREDIT' THEN grand_total ELSE 0 END), 0) AS credit_purchases,
        COALESCE(SUM(CASE WHEN purchase_type = 'CASH' THEN grand_total ELSE 0 END), 0) AS cash_purchases,
        COALESCE(SUM(paid_amount), 0) AS total_pur_paid_field,
        COALESCE(SUM(due_amount), 0) AS total_pur_due_field
    FROM busy_ufo_purchases
    WHERE supplier_id IS NOT NULL AND supplier_id <> ''
    GROUP BY supplier_id, company_id
),
all_pay AS (
    SELECT 
        supplier_id,
        company_id,
        COUNT(*) AS pay_count,
        COALESCE(SUM(amount), 0) AS total_payments
    FROM busy_ufo_supplier_payments
    WHERE supplier_id IS NOT NULL AND supplier_id <> ''
    GROUP BY supplier_id, company_id
),
all_ret AS (
    SELECT 
        supplier_id,
        company_id,
        COUNT(*) AS ret_count,
        COALESCE(SUM(grand_total), 0) AS total_returns
    FROM busy_ufo_purchase_returns
    WHERE supplier_id IS NOT NULL AND supplier_id <> ''
    GROUP BY supplier_id, company_id
)
SELECT 
    s.company_id,
    s.code AS supplier_code,
    s.name AS supplier_name,
    s.opening_bal AS opening_balance,
    COALESCE(p.total_purchases, 0) AS total_purchases,
    COALESCE(pay.total_payments, 0) AS total_payments,
    COALESCE(r.total_returns, 0) AS total_returns,
    (s.opening_bal + COALESCE(p.total_purchases, 0) - COALESCE(pay.total_payments, 0) - COALESCE(r.total_returns, 0)) AS expected_payable_balance,
    s.stored_bal AS stored_payable_balance,
    (s.stored_bal - (s.opening_bal + COALESCE(p.total_purchases, 0) - COALESCE(pay.total_payments, 0) - COALESCE(r.total_returns, 0))) AS balance_variance,
    CASE 
        WHEN ABS(s.stored_bal - (s.opening_bal + COALESCE(p.total_purchases, 0) - COALESCE(pay.total_payments, 0) - COALESCE(r.total_returns, 0))) < 0.01 
        THEN 'RECONCILED'
        ELSE 'HISTORICAL DATA MISMATCH DETECTED'
    END AS audit_status
FROM all_supp s
LEFT JOIN all_pur p ON s.id = p.supplier_id AND s.company_id = p.company_id
LEFT JOIN all_pay pay ON s.id = pay.supplier_id AND s.company_id = pay.company_id
LEFT JOIN all_ret r ON s.id = r.supplier_id AND s.company_id = r.company_id
ORDER BY s.company_id, s.name;


-- ========================================================================================
-- SECTION 3: GLOBAL PRODUCTION CUSTOMER LEDGER AUDIT (MULTI-COMPANY ISOLATED)
-- ========================================================================================

WITH all_cust AS (
    SELECT 
        id, 
        company_id, 
        code, 
        name, 
        COALESCE(opening_balance, 0) AS opening_bal, 
        COALESCE(current_balance, 0) AS stored_bal
    FROM busy_ufo_customers
),
all_sales AS (
    SELECT 
        customer_id,
        company_id,
        COUNT(*) AS sales_count,
        COALESCE(SUM(grand_total), 0) AS total_sales,
        COALESCE(SUM(paid_amount), 0) AS total_sales_paid_field,
        COALESCE(SUM(due_amount), 0) AS total_sales_due_field
    FROM busy_ufo_sales
    WHERE customer_id IS NOT NULL AND customer_id <> ''
    GROUP BY customer_id, company_id
),
all_rec AS (
    SELECT 
        customer_id,
        company_id,
        COUNT(*) AS rec_count,
        COALESCE(SUM(amount), 0) AS total_receipts
    FROM busy_ufo_customer_receipts
    WHERE customer_id IS NOT NULL AND customer_id <> ''
    GROUP BY customer_id, company_id
),
all_sret AS (
    SELECT 
        customer_id,
        company_id,
        COUNT(*) AS sret_count,
        COALESCE(SUM(grand_total), 0) AS total_returns
    FROM busy_ufo_sale_returns
    WHERE customer_id IS NOT NULL AND customer_id <> ''
    GROUP BY customer_id, company_id
)
SELECT 
    c.company_id,
    c.code AS customer_code,
    c.name AS customer_name,
    c.opening_bal AS opening_balance,
    COALESCE(s.total_sales, 0) AS total_sales,
    COALESCE(rec.total_receipts, 0) AS total_receipts,
    COALESCE(sr.total_returns, 0) AS total_returns,
    (c.opening_bal + COALESCE(s.total_sales, 0) - COALESCE(rec.total_receipts, 0) - COALESCE(sr.total_returns, 0)) AS expected_receivable_balance,
    c.stored_bal AS stored_receivable_balance,
    (c.stored_bal - (c.opening_bal + COALESCE(s.total_sales, 0) - COALESCE(rec.total_receipts, 0) - COALESCE(sr.total_returns, 0))) AS balance_variance,
    CASE 
        WHEN ABS(c.stored_bal - (c.opening_bal + COALESCE(s.total_sales, 0) - COALESCE(rec.total_receipts, 0) - COALESCE(sr.total_returns, 0))) < 0.01 
        THEN 'RECONCILED'
        ELSE 'HISTORICAL DATA MISMATCH DETECTED'
    END AS audit_status
FROM all_cust c
LEFT JOIN all_sales s ON c.id = s.customer_id AND c.company_id = s.company_id
LEFT JOIN all_rec rec ON c.id = rec.customer_id AND c.company_id = rec.company_id
LEFT JOIN all_sret sr ON c.id = sr.customer_id AND c.company_id = sr.company_id
ORDER BY c.company_id, c.name;
