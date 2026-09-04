# Production Deployment Guide: ERP System Hardening

Follow these exact steps in order to deploy the hardened ERP transactions and database updates to your live Supabase and hosting environment safely without interrupting customer operations or risking data loss.

---

### Step 1: Backup Supabase Database
1. Go to your **Supabase Dashboard** > **Database** > **Backups**.
2. Create a manual point-in-time backup snapshot before applying any migrations.

### Step 2: Run Read-Only Data Audit
1. Open the Supabase SQL Editor.
2. Open and run the provided **`PRODUCTION_DATA_AUDIT.sql`** script.
3. Review the output to ensure there are no duplicate invoice numbers, orphan items, or negative stock anomalies in your live database.

### Step 3: Apply the New Forward-Only Migration
1. In the Supabase SQL Editor, create a new query.
2. Copy and execute the contents of **`migrations/20260904_production_transaction_safety.sql`**.
3. Verify that the new RPC functions (`update_sale_invoice_rpc`, `update_purchase_invoice_rpc`, `get_transaction_by_request_id`) and unique indexes compile and install successfully without errors.

### Step 4: Deploy Frontend & Backend Build
1. Build the application:
   ```bash
   npm run build
   ```
2. Deploy the build output to your production hosting provider (e.g. Netlify / Cloud Run).

### Step 5: Post-Deployment Smoke Testing
1. Log in to the production ERP application.
2. Execute test transactions (New Sale, Edit Sale, Sales Return, Payment, Receipt) as outlined in **`PRODUCTION_TEST_CHECKLIST.md`**.
3. Verify that document numbering is sequential, stock quantities update correctly, and multi-company isolation holds.

### Step 6: Monitor Logs
1. Monitor Supabase database logs and server error logs for any unhandled exceptions during the first 24 hours of operation.
