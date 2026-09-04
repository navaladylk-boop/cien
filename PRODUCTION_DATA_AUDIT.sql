-- ============================================================
-- PRODUCTION DATA AUDIT (READ-ONLY DIAGNOSTIC SCRIPT)
-- Safe read-only checks for existing production data anomalies,
-- duplicates, orphan items, missing company_ids, and request_id collisions.
-- NO DESTRUCTIVE QUERIES (NO DELETE, UPDATE, TRUNCATE, DROP).
-- ============================================================

-- 1. Check for Duplicate Sales Invoice IDs
SELECT 'Duplicate Sales IDs' AS audit_check, id, COUNT(*) AS count
FROM busy_ufo_sales
GROUP BY id
HAVING COUNT(*) > 1;

-- 2. Check for Duplicate Sales Invoice Numbers per Company
SELECT 'Duplicate Sales Invoice Numbers per Company' AS audit_check, company_id, invoice_number, COUNT(*) AS count
FROM busy_ufo_sales
WHERE invoice_number IS NOT NULL AND invoice_number <> ''
GROUP BY company_id, invoice_number
HAVING COUNT(*) > 1;

-- 3. Check for Duplicate Sales Request IDs
SELECT 'Duplicate Sales Request IDs' AS audit_check, request_id, COUNT(*) AS count
FROM busy_ufo_sales
WHERE request_id IS NOT NULL AND request_id <> ''
GROUP BY request_id
HAVING COUNT(*) > 1;

-- 4. Check for Duplicate Purchase Invoice IDs
SELECT 'Duplicate Purchase IDs' AS audit_check, id, COUNT(*) AS count
FROM busy_ufo_purchases
GROUP BY id
HAVING COUNT(*) > 1;

-- 5. Check for Duplicate Purchase Numbers per Company
SELECT 'Duplicate Purchase Numbers per Company' AS audit_check, company_id, purchase_number, COUNT(*) AS count
FROM busy_ufo_purchases
WHERE purchase_number IS NOT NULL AND purchase_number <> ''
GROUP BY company_id, purchase_number
HAVING COUNT(*) > 1;

-- 6. Check for Duplicate Purchase Request IDs
SELECT 'Duplicate Purchase Request IDs' AS audit_check, request_id, COUNT(*) AS count
FROM busy_ufo_purchases
WHERE request_id IS NOT NULL AND request_id <> ''
GROUP BY request_id
HAVING COUNT(*) > 1;

-- 7. Check for Duplicate Customer Receipts Numbers per Company
SELECT 'Duplicate Receipt Numbers per Company' AS audit_check, company_id, receipt_number, COUNT(*) AS count
FROM busy_ufo_customer_receipts
WHERE receipt_number IS NOT NULL AND receipt_number <> ''
GROUP BY company_id, receipt_number
HAVING COUNT(*) > 1;

-- 8. Check for Duplicate Supplier Payments Numbers per Company
SELECT 'Duplicate Payment Numbers per Company' AS audit_check, company_id, payment_number, COUNT(*) AS count
FROM busy_ufo_supplier_payments
WHERE payment_number IS NOT NULL AND payment_number <> ''
GROUP BY company_id, payment_number
HAVING COUNT(*) > 1;

-- 9. Check for Orphan Sale Items (items referencing non-existent sales invoice)
SELECT 'Orphan Sale Items' AS audit_check, si.id, si.invoice_id
FROM busy_ufo_sale_items si
LEFT JOIN busy_ufo_sales s ON si.invoice_id = s.id
WHERE s.id IS NULL;

-- 10. Check for Orphan Purchase Items (items referencing non-existent purchase)
SELECT 'Orphan Purchase Items' AS audit_check, pi.id, pi.purchase_id
FROM busy_ufo_purchase_items pi
LEFT JOIN busy_ufo_purchases p ON pi.purchase_id = p.id
WHERE p.id IS NULL;

-- 11. Check for Transactions Without Company ID
SELECT 'Sales without Company ID' AS audit_check, id, invoice_number FROM busy_ufo_sales WHERE company_id IS NULL OR company_id = '';
SELECT 'Purchases without Company ID' AS audit_check, id, purchase_number FROM busy_ufo_purchases WHERE company_id IS NULL OR company_id = '';
SELECT 'Receipts without Company ID' AS audit_check, id, receipt_number FROM busy_ufo_customer_receipts WHERE company_id IS NULL OR company_id = '';
SELECT 'Payments without Company ID' AS audit_check, id, payment_number FROM busy_ufo_supplier_payments WHERE company_id IS NULL OR company_id = '';

-- 12. Check for Suspicious Negative Stock Values
SELECT 'Negative Stock Products' AS audit_check, id, code, name, current_stock, company_id
FROM busy_ufo_products
WHERE current_stock < 0;

-- 13. Summary Counts of All Core Tables
SELECT 'Table Record Counts' AS audit_check, 'companies' AS tbl, COUNT(*) FROM companies
UNION ALL SELECT 'Table Record Counts', 'app_users', COUNT(*) FROM app_users
UNION ALL SELECT 'Table Record Counts', 'busy_ufo_customers', COUNT(*) FROM busy_ufo_customers
UNION ALL SELECT 'Table Record Counts', 'busy_ufo_suppliers', COUNT(*) FROM busy_ufo_suppliers
UNION ALL SELECT 'Table Record Counts', 'busy_ufo_products', COUNT(*) FROM busy_ufo_products
UNION ALL SELECT 'Table Record Counts', 'busy_ufo_sales', COUNT(*) FROM busy_ufo_sales
UNION ALL SELECT 'Table Record Counts', 'busy_ufo_purchases', COUNT(*) FROM busy_ufo_purchases
UNION ALL SELECT 'Table Record Counts', 'busy_ufo_customer_receipts', COUNT(*) FROM busy_ufo_customer_receipts
UNION ALL SELECT 'Table Record Counts', 'busy_ufo_supplier_payments', COUNT(*) FROM busy_ufo_supplier_payments
UNION ALL SELECT 'Table Record Counts', 'busy_ufo_expenses', COUNT(*) FROM busy_ufo_expenses;
