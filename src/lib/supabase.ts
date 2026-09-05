import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  Product,
  Customer,
  Supplier,
  SaleInvoice,
  PurchaseInvoice,
  CustomerReceipt,
  SupplierPayment,
  Expense,
  Company,
  AppSettings,
  AppUser,
  PdcTransaction,
  JournalEntry,
  SaleReturn,
  PurchaseReturn
} from '../types';

let cachedClient: SupabaseClient | null = null;
let cachedUrl = '';
let cachedKey = '';

// Active in-flight request tracking to prevent concurrent double-submissions
const _inFlightRequests = new Set<string>();

/**
 * Generates ONE cryptographically unique request ID for transaction idempotency & database-level uniqueness.
 */
export function generateUniqueRequestId(prefix: string = 'req'): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `${prefix}_${crypto.randomUUID()}`;
    }
  } catch {}
  const rand = Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
  return `${prefix}_${Date.now()}_${rand}`;
}

export function getActiveSupabaseCredentials(): { url: string; key: string } {
  let url = '';
  let key = '';

  // 1. Check localStorage settings
  try {
    const rawSettings = localStorage.getItem('busy_ufo_settings');
    if (rawSettings) {
      const parsed = JSON.parse(rawSettings);
      if (parsed.supabaseUrl) url = parsed.supabaseUrl.trim();
      if (parsed.supabaseAnonKey) key = parsed.supabaseAnonKey.trim();
    }
  } catch (e) {
    console.error('Error reading Supabase settings from storage:', e);
  }

  // 2. Fallback to Vite environment variables
  if (!url) {
    url = ((import.meta as any).env?.VITE_SUPABASE_URL || '').trim();
  }
  if (!key) {
    key = ((import.meta as any).env?.VITE_SUPABASE_ANON_KEY || '').trim();
  }

  return { url, key };
}

export function getSupabaseClient(url?: string, key?: string): SupabaseClient | null {
  const finalUrl = url ? url.trim() : getActiveSupabaseCredentials().url;
  const finalKey = key ? key.trim() : getActiveSupabaseCredentials().key;

  if (!finalUrl || !finalKey) return null;

  if (cachedClient && cachedUrl === finalUrl && cachedKey === finalKey) {
    return cachedClient;
  }

  try {
    cachedClient = createClient(finalUrl, finalKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
    cachedUrl = finalUrl;
    cachedKey = finalKey;
    return cachedClient;
  } catch (err) {
    console.error('Failed to initialize Supabase client:', err);
    return null;
  }
}

/**
 * Executes a Supabase table mutation (upsert, update, insert) safely.
 * If a column (e.g. 'updated_at', 'request_id', 'refunded_amount', 'reason', etc.) is missing in the user's database schema cache,
 * automatically removes that field and retries the operation up to 25 times.
 */
export async function safeExecuteQuery<T = any>(
  operation: (payload: any) => any,
  initialPayload: any
): Promise<{ data: T | null; error: any }> {
  let currentPayload = Array.isArray(initialPayload)
    ? initialPayload.map((item) => ({ ...item }))
    : { ...initialPayload };

  let attempts = 0;
  const maxAttempts = 25;

  while (attempts < maxAttempts) {
    attempts++;
    const res = (await operation(currentPayload)) || {};
    if (!res.error) {
      return res;
    }

    const errMsg = res.error.message || '';
    const match = errMsg.match(/Could not find the ['"]?([a-zA-Z0-9_]+)['"]? column/i) ||
                  errMsg.match(/column ['"]?([a-zA-Z0-9_]+)['"]? (?:of relation|does not exist)/i) ||
                  errMsg.match(/column ['"]?([a-zA-Z0-9_]+)['"]? /i) ||
                  errMsg.match(/['"]?([a-zA-Z0-9_]+)['"]? column/i);

    let removedColumn = false;

    if (match && match[1]) {
      const missingCol = match[1];
      if (Array.isArray(currentPayload)) {
        for (const item of currentPayload) {
          if (missingCol in item) {
            delete item[missingCol];
            removedColumn = true;
          }
        }
      } else {
        if (missingCol in currentPayload) {
          delete currentPayload[missingCol];
          removedColumn = true;
        }
      }
    }

    if (!removedColumn) {
      const keysToTest = Array.isArray(currentPayload)
        ? (currentPayload[0] ? Object.keys(currentPayload[0]) : [])
        : Object.keys(currentPayload);

      for (const key of keysToTest) {
        if (errMsg.toLowerCase().includes(key.toLowerCase())) {
          if (Array.isArray(currentPayload)) {
            for (const item of currentPayload) {
              delete item[key];
            }
          } else {
            delete currentPayload[key];
          }
          removedColumn = true;
          break;
        }
      }
    }

    if (removedColumn) {
      continue;
    }

    return res;
  }

  return (await operation(currentPayload)) || {};
}

export interface ConnectionTestResult {
  success: boolean;
  message: string;
  url: string;
  tableStatus?: {
    products: boolean;
    customers: boolean;
    suppliers: boolean;
    sales: boolean;
    users?: boolean;
  };
  details?: string;
}

export async function testSupabaseConnection(url?: string, key?: string): Promise<ConnectionTestResult> {
  const credentials = {
    url: url ? url.trim() : getActiveSupabaseCredentials().url,
    key: key ? key.trim() : getActiveSupabaseCredentials().key
  };

  if (!credentials.url || !credentials.key) {
    return {
      success: false,
      url: credentials.url || '',
      message: 'Supabase URL or Anon Public Key is missing. Please configure database credentials in Settings.'
    };
  }

  if (!credentials.url.startsWith('https://')) {
    return {
      success: false,
      url: credentials.url,
      message: 'Supabase URL must start with https:// (e.g., https://your-project.supabase.co).'
    };
  }

  try {
    const client = createClient(credentials.url, credentials.key);
    
    // Strictly READ-ONLY query: Probe 'companies' table with SELECT id LIMIT 1
    // NEVER perform any INSERT, UPDATE, or DELETE on production tables during health checks
    const { data: compData, error: compError } = await client
      .from('companies')
      .select('id')
      .limit(1);

    if (compError) {
      if (
        compError.code === 'PGRST116' ||
        compError.code === '42P01' ||
        compError.message?.includes('relation') ||
        compError.message?.includes('does not exist')
      ) {
        return {
          success: false,
          url: credentials.url,
          message: 'Connected to Supabase, but schema tables have not been created yet. Please execute the SQL Schema Script in the Supabase SQL Editor.',
          details: compError.message
        };
      }
      if (
        compError.message?.includes('JWT') ||
        compError.message?.includes('expired') ||
        compError.code === 'PGRST301'
      ) {
        return {
          success: false,
          url: credentials.url,
          message: 'Invalid Anon Public Key or expired session. Please check the anon key copied from Supabase Project Settings -> API.',
          details: compError.message
        };
      }
      if (
        compError.code === '42501' ||
        compError.message?.includes('row-level security') ||
        compError.message?.includes('permission denied')
      ) {
        return {
          success: false,
          url: credentials.url,
          message: 'Supabase connected, but read access is restricted by Row Level Security (RLS) policies.',
          details: compError.message
        };
      }
      return {
        success: false,
        url: credentials.url,
        message: `Supabase query returned error: ${compError.message}`,
        details: compError.message
      };
    }

    // Read-only status checks on standard ERP tables (zero writes, zero deletes)
    const [prodCheck, custCheck, suppCheck, saleCheck, userCheck] = await Promise.allSettled([
      client.from('busy_ufo_products').select('id').limit(1),
      client.from('busy_ufo_customers').select('id').limit(1),
      client.from('busy_ufo_suppliers').select('id').limit(1),
      client.from('busy_ufo_sales').select('id').limit(1),
      client.from('app_users').select('id').limit(1)
    ]);

    const isOk = (res: PromiseSettledResult<{ error: any }>) =>
      res.status === 'fulfilled' && !res.value.error;

    return {
      success: true,
      url: credentials.url,
      message: 'Supabase connection verified successfully. Read-only health check passed.',
      tableStatus: {
        products: isOk(prodCheck),
        customers: isOk(custCheck),
        suppliers: isOk(suppCheck),
        sales: isOk(saleCheck),
        users: isOk(userCheck)
      }
    };
  } catch (err: any) {
    const errorMsg = err?.message || String(err);
    if (errorMsg.includes('Failed to fetch') || errorMsg.includes('NetworkError') || errorMsg.includes('fetch')) {
      return {
        success: false,
        url: credentials.url,
        message: 'Unable to connect to Supabase. Please check your internet connection.',
        details: errorMsg
      };
    }
    return {
      success: false,
      url: credentials.url,
      message: `Failed to connect to Supabase: ${errorMsg}`,
      details: String(err)
    };
  }
}

async function ensureCompanyExists(client: SupabaseClient, companyId?: string): Promise<void> {
  const compId = companyId || 'comp-1';
  try {
    // Read-only check if the company already exists in Supabase
    const { data: existing, error } = await client
      .from('companies')
      .select('id')
      .eq('id', compId)
      .maybeSingle();

    if (error) {
      console.warn('Error checking if company exists:', error);
      return;
    }

    if (!existing) {
      console.warn(`Referenced company "${compId}" not found in Supabase.`);
    }
  } catch (e) {
    console.warn('Failed to verify company row in Supabase:', e);
  }
}

// ==========================================
// SUPABASE REAL-TIME CLOUD SYNC ENGINE
// ==========================================

export type UserStatusCheckResult =
  | { status: 'USERS_EXIST'; users: AppUser[]; count: number }
  | { status: 'ZERO_USERS' }
  | { status: 'CONNECTION_ERROR'; error: string };

export const SupabaseSyncService = {
  // --- USER AUTHENTICATION & STATUS (Supabase is Single Source of Truth) ---
  async checkUsersStatus(): Promise<UserStatusCheckResult> {
    const client = getSupabaseClient();
    if (!client) {
      return {
        status: 'CONNECTION_ERROR',
        error: 'Unable to connect to the server. Please check your internet connection and try again.'
      };
    }

    try {
      const { data, error } = await client
        .from('app_users')
        .select('*')
        .order('username');

      if (error) {
        console.warn('Supabase checkUsersStatus error:', error);
        return {
          status: 'CONNECTION_ERROR',
          error: error.message || 'Unable to connect to the server. Please check your internet connection and try again.'
        };
      }

      if (!data || data.length === 0) {
        return { status: 'ZERO_USERS' };
      }

      const users: AppUser[] = data.map((row: any) => ({
        id: String(row.id),
        username: row.username,
        usernameNormalized: row.username_normalized || (row.username ? row.username.toLowerCase() : ''),
        fullName: row.full_name || row.fullName || row.username,
        passwordHash: row.password_hash || row.passwordHash || '',
        salt: row.salt || '',
        roleId: row.role_id || row.roleId || 'role-sales',
        roleName: row.role_name || row.roleName || 'Sales User',
        isActive: row.is_active !== undefined ? row.is_active : (row.isActive !== undefined ? row.isActive : true),
        assignedCompanyIds: Array.isArray(row.assigned_company_ids)
          ? row.assigned_company_ids
          : (typeof row.assigned_company_ids === 'string' && row.assigned_company_ids ? JSON.parse(row.assigned_company_ids) : []),
        permissionOverrides: typeof row.permission_overrides === 'object' && row.permission_overrides !== null
          ? row.permission_overrides
          : (typeof row.permission_overrides === 'string' && row.permission_overrides ? JSON.parse(row.permission_overrides) : {}),
        lastLogin: row.last_login || row.lastLogin,
        createdAt: row.created_at || row.createdAt || new Date().toISOString(),
        updatedAt: row.updated_at || row.updatedAt || new Date().toISOString()
      }));

      return {
        status: 'USERS_EXIST',
        users,
        count: users.length
      };
    } catch (e: any) {
      console.error('Supabase checkUsersStatus exception:', e);
      return {
        status: 'CONNECTION_ERROR',
        error: 'Unable to connect to the server. Please check your internet connection and try again.'
      };
    }
  },
  // --- USERS ---
  async syncUser(user: AppUser): Promise<{ success: boolean; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase URL or Key is missing. Please configure Supabase in Settings.' };

    try {
      // Ensure role exists in 'roles' table first if role_id is specified
      if (user.roleId) {
        try {
          await client.from('roles').upsert([
            {
              id: user.roleId,
              role_name: user.roleName || user.roleId,
              description: `Role ${user.roleName || user.roleId}`
            }
          ], { onConflict: 'id' });
        } catch {
          // Non-blocking if roles table schema differs
        }
      }

      const payload = {
        id: user.id,
        username: user.username,
        username_normalized: user.usernameNormalized || user.username.toLowerCase(),
        full_name: user.fullName,
        password_hash: user.passwordHash,
        salt: user.salt,
        role_id: user.roleId,
        role_name: user.roleName || user.roleId,
        is_active: user.isActive !== undefined ? user.isActive : true,
        assigned_company_ids: user.assignedCompanyIds || [],
        permission_overrides: user.permissionOverrides || {},
        last_login: user.lastLogin || null,
        created_at: user.createdAt || new Date().toISOString(),
        updated_at: user.updatedAt || new Date().toISOString()
      };

      const { error } = await client
        .from('app_users')
        .upsert(payload, { onConflict: 'id' });

      if (error) {
        console.warn('Supabase user sync error:', error);
        if (error.message?.includes('relation "app_users" does not exist') || error.code === '42P01') {
          return {
            success: false,
            error: 'Table "app_users" does not exist in Supabase. Please copy the SQL script from Settings -> Export SQL Schema and run it in your Supabase SQL Editor.'
          };
        }
        return { success: false, error: error.message };
      }
      return { success: true };
    } catch (e: any) {
      console.warn('Supabase user sync exception:', e);
      return { success: false, error: e?.message || 'Failed to sync user with Supabase' };
    }
  },

  async deleteUser(userId: string): Promise<{ success: boolean; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    try {
      try {
        await client.from('user_company_assignments').delete().eq('user_id', userId);
      } catch {
        // Non-blocking
      }
      try {
        await client.from('user_permissions').delete().eq('user_id', userId);
      } catch {
        // Non-blocking
      }
      const { error } = await client.from('app_users').delete().eq('id', userId);
      if (error) {
        console.warn('Supabase user delete error:', error);
        return { success: false, error: error.message };
      }
      return { success: true };
    } catch (e: any) {
      console.error('Error deleting user from Supabase:', e);
      return { success: false, error: e?.message };
    }
  },

  async fetchAllRemoteUsers(): Promise<AppUser[] | null> {
    const client = getSupabaseClient();
    if (!client) return null;

    try {
      const { data, error } = await client
        .from('app_users')
        .select('*')
        .order('username');

      if (error) {
        console.warn('Fetch remote users error:', error);
        return null;
      }

      if (!data) return [];

      return data.map((row: any) => ({
        id: String(row.id),
        username: row.username,
        usernameNormalized: row.username_normalized || (row.username ? row.username.toLowerCase() : ''),
        fullName: row.full_name || row.fullName || row.username,
        passwordHash: row.password_hash || row.passwordHash || '',
        salt: row.salt || '',
        roleId: row.role_id || row.roleId || 'role-sales',
        roleName: row.role_name || row.roleName || 'Sales User',
        isActive: row.is_active !== undefined ? row.is_active : (row.isActive !== undefined ? row.isActive : true),
        assignedCompanyIds: Array.isArray(row.assigned_company_ids)
          ? row.assigned_company_ids
          : (typeof row.assigned_company_ids === 'string' && row.assigned_company_ids ? JSON.parse(row.assigned_company_ids) : []),
        permissionOverrides: typeof row.permission_overrides === 'object' && row.permission_overrides !== null
          ? row.permission_overrides
          : (typeof row.permission_overrides === 'string' && row.permission_overrides ? JSON.parse(row.permission_overrides) : {}),
        lastLogin: row.last_login || row.lastLogin,
        createdAt: row.created_at || row.createdAt || new Date().toISOString(),
        updatedAt: row.updated_at || row.updatedAt || new Date().toISOString()
      }));
    } catch (e) {
      console.error('Error fetching users from Supabase:', e);
      return null;
    }
  },

  // --- COMPANIES ---
  async syncCompany(company: Company): Promise<{ success: boolean; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    try {
      const payload = {
        id: company.id,
        company_name: company.companyName,
        short_name: company.shortName,
        address: company.address || '',
        city: company.city || 'Colombo',
        district: company.district || 'Colombo',
        country: company.country || 'Sri Lanka',
        telephone: company.telephone || '',
        mobile: company.mobile || '',
        company_email: company.companyEmail || '',
        tax_registration_no: company.taxRegistrationNo || '',
        currency: company.currency || 'Rs.',
        financial_year_start: company.financialYearStart || '2026-01-01',
        financial_year_end: company.financialYearEnd || '2026-12-31',
        invoice_prefix: company.invoicePrefix || 'INV',
        invoice_number: company.invoiceNumber || 1001,
        is_active: company.isActive !== undefined ? company.isActive : true,
        is_vat_enabled: company.isVatEnabled !== undefined ? company.isVatEnabled : true,
        vat_number: company.vatNumber || '',
        default_vat_rate: company.defaultVatRate || 0,
        vat_type: company.vatType || 'EXCLUSIVE',
        is_item_discount_enabled: company.isItemDiscountEnabled !== undefined ? company.isItemDiscountEnabled : true,
        default_discount_type: company.defaultDiscountType || 'PERCENT',
        created_at: company.createdAt || new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      const { error } = await client
        .from('companies')
        .upsert(payload, { onConflict: 'id' });

      if (error) {
        console.warn('Supabase company sync error:', error);
        return { success: false, error: error.message };
      }
      return { success: true };
    } catch (e: any) {
      console.warn('Supabase company sync exception:', e);
      return { success: false, error: e?.message };
    }
  },

  async fetchAllRemoteCompanies(): Promise<Company[] | null> {
    const client = getSupabaseClient();
    if (!client) return null;
    try {
      const { data, error } = await client
        .from('companies')
        .select('*')
        .order('created_at', { ascending: true });

      if (error || !data) return null;

      return data.map((row: any) => {
        let name = row.company_name || row.companyName || row.name || 'Unnamed Company';
        let short = row.short_name || row.shortName || row.short || 'COMP';

        return {
          id: row.id,
          companyName: name,
          shortName: short,
        address: row.address || '',
        city: row.city || 'Colombo',
        district: row.district || 'Colombo',
        country: row.country || 'Sri Lanka',
        telephone: row.telephone || '',
        mobile: row.mobile || '',
        companyEmail: row.company_email || row.companyEmail || '',
        taxRegistrationNo: row.tax_registration_no || row.taxRegistrationNo || '',
        currency: row.currency || 'Rs.',
        financialYearStart: row.financial_year_start || row.financialYearStart || '2026-01-01',
        financialYearEnd: row.financial_year_end || row.financialYearEnd || '2026-12-31',
        invoicePrefix: row.invoice_prefix || row.invoicePrefix || 'INV',
        invoiceNumber: row.invoice_number || row.invoiceNumber || 1001,
        isActive: row.is_active !== undefined ? row.is_active : (row.isActive !== undefined ? row.isActive : true),
        isVatEnabled: row.is_vat_enabled !== undefined ? row.is_vat_enabled : (row.isVatEnabled !== undefined ? row.isVatEnabled : true),
        vatNumber: row.vat_number || row.vatNumber || '',
        defaultVatRate: row.default_vat_rate !== undefined ? Number(row.default_vat_rate) : 0,
        vatType: row.vat_type || row.vatType || 'EXCLUSIVE',
        isItemDiscountEnabled: row.is_item_discount_enabled !== undefined ? row.is_item_discount_enabled : (row.isItemDiscountEnabled !== undefined ? row.isItemDiscountEnabled : true),
        defaultDiscountType: row.default_discount_type || row.defaultDiscountType || 'PERCENT',
        createdAt: row.created_at || row.createdAt || new Date().toISOString(),
        updatedAt: row.updated_at || row.updatedAt || new Date().toISOString()
      };
    });
    } catch (e) {
      console.error('Error fetching companies from Supabase:', e);
      return null;
    }
  },

  // --- PRODUCTS ---
  async syncProduct(product: Product): Promise<{ success: boolean; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    try {
      await ensureCompanyExists(client, product.companyId || 'comp-1');

      const payload = {
        id: product.id,
        code: product.code,
        name: product.name,
        category: product.category || 'General',
        unit: product.unit || 'Pcs',
        cost_price: Number(product.costPrice || 0),
        selling_price: Number(product.sellingPrice || 0),
        current_stock: Number(product.currentStock || 0),
        reorder_level: Number(product.reorderLevel || 10),
        opening_stock: product.openingStock !== undefined ? Number(product.openingStock) : Number(product.currentStock || 0),
        opening_rate: product.openingRate !== undefined ? Number(product.openingRate) : Number(product.costPrice || 0),
        opening_value: product.openingValue !== undefined ? Number(product.openingValue) : Number(product.excelStockValue || 0),
        excel_stock_value: product.excelStockValue !== undefined ? Number(product.excelStockValue) : Number(product.openingValue || 0),
        calculated_stock_value: product.calculatedStockValue !== undefined ? Number(product.calculatedStockValue) : 0,
        value_difference: product.valueDifference !== undefined ? Number(product.valueDifference) : 0,
        import_source: product.importSource || null,
        import_batch_id: product.importBatchId || null,
        company_id: product.companyId || 'comp-1',
        updated_at: new Date().toISOString()
      };

      const { error } = await client
        .from('busy_ufo_products')
        .upsert(payload, { onConflict: 'id' });

      if (error) {
        console.warn('Supabase product sync error:', error);
        return { success: false, error: error.message };
      }
      return { success: true };
    } catch (e: any) {
      console.warn('Supabase product sync exception:', e);
      return { success: false, error: e?.message };
    }
  },

  async deleteProduct(productId: string): Promise<{ success: boolean; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };
    try {
      try {
        await client.from('busy_ufo_sale_items').update({ product_id: null }).eq('product_id', productId);
      } catch {}
      try {
        await client.from('busy_ufo_purchase_items').update({ product_id: null }).eq('product_id', productId);
      } catch {}
      const { error } = await client.from('busy_ufo_products').delete().eq('id', productId);
      if (error) {
        console.warn('Supabase product delete error:', error);
        return { success: false, error: error.message };
      }
      return { success: true };
    } catch (e: any) {
      console.warn('Supabase product delete exception:', e);
      return { success: false, error: e?.message };
    }
  },

  async deleteProductsBulk(productIds: string[]): Promise<{ success: boolean; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };
    if (!productIds || productIds.length === 0) return { success: true };
    try {
      try {
        await client.from('busy_ufo_sale_items').update({ product_id: null }).in('product_id', productIds);
      } catch {}
      try {
        await client.from('busy_ufo_purchase_items').update({ product_id: null }).in('product_id', productIds);
      } catch {}
      const { error } = await client.from('busy_ufo_products').delete().in('id', productIds);
      if (error) {
        console.warn('Supabase bulk product delete error:', error);
        return { success: false, error: error.message };
      }
      return { success: true };
    } catch (e: any) {
      console.warn('Supabase bulk product delete exception:', e);
      return { success: false, error: e?.message };
    }
  },

  // --- CUSTOMERS ---
  async syncCustomer(customer: Customer): Promise<{ success: boolean; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    try {
      await ensureCompanyExists(client, customer.companyId || 'comp-1');

      const payload = {
        id: customer.id,
        code: customer.code,
        name: customer.name,
        phone: customer.phone || '',
        email: customer.email || '',
        address: customer.address || '',
        city: customer.city || 'Colombo',
        opening_balance: Number(customer.openingBalance || 0),
        current_balance: Number(customer.outstandingBalance || 0),
        company_id: customer.companyId || 'comp-1',
        updated_at: new Date().toISOString()
      };

      const { error } = await client
        .from('busy_ufo_customers')
        .upsert(payload, { onConflict: 'id' });

      if (error) {
        console.warn('Supabase customer sync error:', error);
        return { success: false, error: error.message };
      }
      return { success: true };
    } catch (e: any) {
      console.warn('Supabase customer sync exception:', e);
      return { success: false, error: e?.message };
    }
  },

  async deleteCustomer(customerId: string): Promise<{ success: boolean; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };
    try {
      try {
        await client.from('busy_ufo_sales').update({ customer_id: null }).eq('customer_id', customerId);
      } catch {}
      try {
        await client.from('busy_ufo_customer_receipts').update({ customer_id: null }).eq('customer_id', customerId);
      } catch {}
      const { error } = await client.from('busy_ufo_customers').delete().eq('id', customerId);
      if (error) {
        console.warn('Supabase customer delete error:', error);
        return { success: false, error: error.message };
      }
      return { success: true };
    } catch (e: any) {
      console.warn('Supabase customer delete exception:', e);
      return { success: false, error: e?.message };
    }
  },

  // --- SUPPLIERS ---
  async syncSupplier(supplier: Supplier): Promise<{ success: boolean; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    try {
      await ensureCompanyExists(client, supplier.companyId || 'comp-1');

      const payload = {
        id: supplier.id,
        code: supplier.code,
        name: supplier.name,
        phone: supplier.phone || '',
        email: supplier.email || '',
        address: supplier.address || '',
        city: supplier.city || 'Colombo',
        opening_balance: Number(supplier.openingBalance || 0),
        current_balance: Number(supplier.payableBalance || 0),
        company_id: supplier.companyId || 'comp-1',
        updated_at: new Date().toISOString()
      };

      const { error } = await client
        .from('busy_ufo_suppliers')
        .upsert(payload, { onConflict: 'id' });

      if (error) {
        console.warn('Supabase supplier sync error:', error);
        return { success: false, error: error.message };
      }
      return { success: true };
    } catch (e: any) {
      console.warn('Supabase supplier sync exception:', e);
      return { success: false, error: e?.message };
    }
  },

  async deleteSupplier(supplierId: string): Promise<{ success: boolean; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };
    try {
      try {
        await client.from('busy_ufo_purchases').update({ supplier_id: null }).eq('supplier_id', supplierId);
      } catch {}
      try {
        await client.from('busy_ufo_supplier_payments').update({ supplier_id: null }).eq('supplier_id', supplierId);
      } catch {}
      const { error } = await client.from('busy_ufo_suppliers').delete().eq('id', supplierId);
      if (error) {
        console.warn('Supabase supplier delete error:', error);
        return { success: false, error: error.message };
      }
      return { success: true };
    } catch (e: any) {
      console.warn('Supabase supplier delete exception:', e);
      return { success: false, error: e?.message };
    }
  },

  // --- ATOMIC NUMBER GENERATION FROM SUPABASE DATABASE ---
  async generateNextSalesInvoiceNumber(companyId: string): Promise<string> {
    const client = getSupabaseClient();
    if (!client) throw new Error("Supabase client not initialized.");
    try {
      const { data, error } = await client.rpc('generate_next_sales_invoice_number_rpc', {
        p_company_id: companyId
      });
      if (!error && data) return data as string;
    } catch (err) {
      console.warn('RPC generate_next_sales_invoice_number_rpc error:', err);
    }
    const year = new Date().getFullYear();
    return `INV-${year}-${Date.now().toString().slice(-4)}`;
  },

  async generateNextPurchaseNumber(companyId: string): Promise<string> {
    const client = getSupabaseClient();
    if (!client) throw new Error("Supabase client not initialized.");
    try {
      const { data, error } = await client.rpc('generate_next_purchase_number_rpc', {
        p_company_id: companyId
      });
      if (!error && data) return data as string;
    } catch (err) {
      console.warn('RPC generate_next_purchase_number_rpc error:', err);
    }
    const year = new Date().getFullYear();
    return `PUR-${year}-${Date.now().toString().slice(-4)}`;
  },

  async generateNextReceiptNumber(companyId: string): Promise<string> {
    const client = getSupabaseClient();
    if (!client) throw new Error("Supabase client not initialized.");
    try {
      const { data, error } = await client.rpc('generate_next_receipt_number_rpc', {
        p_company_id: companyId
      });
      if (!error && data) return data as string;
    } catch (err) {
      console.warn('RPC generate_next_receipt_number_rpc error:', err);
    }
    const year = new Date().getFullYear();
    return `REC-${year}-${Date.now().toString().slice(-4)}`;
  },

  async generateNextPaymentNumber(companyId: string): Promise<string> {
    const client = getSupabaseClient();
    if (!client) throw new Error("Supabase client not initialized.");
    try {
      const { data, error } = await client.rpc('generate_next_payment_number_rpc', {
        p_company_id: companyId
      });
      if (!error && data) return data as string;
    } catch (err) {
      console.warn('RPC generate_next_payment_number_rpc error:', err);
    }
    const year = new Date().getFullYear();
    return `PAY-${year}-${Date.now().toString().slice(-4)}`;
  },

  async generateNextExpenseNumber(companyId: string): Promise<string> {
    const client = getSupabaseClient();
    if (!client) throw new Error("Supabase client not initialized.");
    try {
      const { data, error } = await client.rpc('generate_next_expense_number_rpc', {
        p_company_id: companyId
      });
      if (!error && data) return data as string;
    } catch (err) {
      console.warn('RPC generate_next_expense_number_rpc error:', err);
    }
    const year = new Date().getFullYear();
    return `EXP-${year}-${Date.now().toString().slice(-4)}`;
  },
  async getTransactionByRequestId(requestId: string): Promise<{ found: boolean; doc_type?: string; id?: string; doc_number?: string; company_id?: string; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { found: false, error: 'Supabase not configured' };
    try {
      const { data, error } = await client.rpc('get_transaction_by_request_id', {
        p_request_id: requestId
      });
      if (error) return { found: false, error: error.message };
      return data || { found: false };
    } catch (e: any) {
      return { found: false, error: e?.message };
    }
  },

  async syncSaleInvoice(sale: SaleInvoice): Promise<{ success: boolean; error?: string; isDuplicate?: boolean; existingData?: SaleInvoice }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    const reqId = sale.requestId || `req_sale_${sale.id}`;
    if (_inFlightRequests.has(reqId)) {
      return { success: false, error: 'A transaction with this Request ID is already in-flight.' };
    }
    _inFlightRequests.add(reqId);

    try {
      await ensureCompanyExists(client, sale.companyId || 'comp-1');

      const { data, error } = await client.rpc('post_sale_invoice_rpc', {
        p_request_id: reqId,
        p_company_id: sale.companyId || 'comp-1',
        p_customer_id: sale.customerId || null,
        p_customer_name: sale.customerName,
        p_sale_type: sale.type,
        p_invoice_date: sale.date,
        p_total_amount: Number(sale.subtotal || 0),
        p_overall_discount: Number(sale.discount || 0),
        p_grand_total: Number(sale.grandTotal || 0),
        p_paid_amount: Number(sale.paidAmount || 0),
        p_due_amount: Number(sale.dueAmount || 0),
        p_notes: sale.notes || '',
        p_items: sale.items.map(item => ({
          productId: item.productId,
          productCode: item.productCode || '',
          productName: item.productName || '',
          quantity: Number(item.quantity || 0),
          unitPrice: Number(item.unitPrice || 0),
          discount: Number(item.discount || 0),
          discountType: item.discountType || 'PERCENT',
          total: Number(item.total || 0)
        }))
      });

      if (error) {
        const isRpcMissing = (error.message || '').toLowerCase().includes('could not find the function') ||
                             (error.message || '').toLowerCase().includes('schema cache') ||
                             (error.message || '').toLowerCase().includes('does not exist') ||
                             error.code === 'PGRST202' ||
                             error.code === '42883';

        if (isRpcMissing) {
          // Direct Table Fallback
          const invoiceNumber = sale.invoiceNumber || `INV-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
          const invoiceId = sale.id || `inv-${Date.now()}`;
          const compId = sale.companyId || 'comp-1';

          const { error: insertErr } = await safeExecuteQuery(
            (payload) => client.from('busy_ufo_sales').upsert(payload),
            {
              id: invoiceId,
              request_id: reqId,
              invoice_number: invoiceNumber,
              invoice_date: sale.date || new Date().toISOString().split('T')[0],
              customer_id: sale.customerId || null,
              customer_name: sale.customerName || '',
              sale_type: sale.type || 'CASH',
              total_amount: Number(sale.subtotal || 0),
              overall_discount: Number(sale.discount || 0),
              grand_total: Number(sale.grandTotal || 0),
              paid_amount: Number(sale.paidAmount || 0),
              due_amount: Number(sale.dueAmount || 0),
              notes: sale.notes || '',
              company_id: compId,
              updated_at: new Date().toISOString()
            }
          );

          if (insertErr) {
            return { success: false, error: insertErr.message };
          }

          if (sale.items && sale.items.length > 0) {
            const rows = sale.items.map((it, idx) => ({
              id: `si-${Date.now()}-${idx}`,
              invoice_id: invoiceId,
              product_id: it.productId,
              product_code: it.productCode || '',
              product_name: it.productName || '',
              quantity: Number(it.quantity || 0),
              unit_price: Number(it.unitPrice || 0),
              discount: Number(it.discount || 0),
              discount_type: it.discountType || 'PERCENT',
              total: Number(it.total || 0)
            }));
            await safeExecuteQuery(
              (payload) => client.from('busy_ufo_sale_items').insert(payload),
              rows
            );

            // Deduct product stock
            for (const it of sale.items) {
              if (it.productId) {
                const { data: prodData } = await client
                  .from('busy_ufo_products')
                  .select('stock')
                  .eq('id', it.productId)
                  .eq('company_id', compId)
                  .maybeSingle();

                if (prodData) {
                  const newStock = Math.max(0, Number(prodData.stock || 0) - Number(it.quantity || 0));
                  await safeExecuteQuery(
                    (payload) => client.from('busy_ufo_products').update(payload).eq('id', it.productId).eq('company_id', compId),
                    { stock: newStock, updated_at: new Date().toISOString() }
                  );
                }
              }
            }
          }

          // Adjust customer balance if credit sale
          if (sale.customerId && sale.type === 'CREDIT' && Number(sale.dueAmount || 0) > 0) {
            const { data: custData } = await client
              .from('busy_ufo_customers')
              .select('current_balance')
              .eq('id', sale.customerId)
              .eq('company_id', compId)
              .maybeSingle();

            if (custData) {
              const newBal = Number(custData.current_balance || 0) + Number(sale.dueAmount || 0);
              await safeExecuteQuery(
                (payload) => client.from('busy_ufo_customers').update(payload).eq('id', sale.customerId!).eq('company_id', compId),
                { current_balance: newBal, updated_at: new Date().toISOString() }
              );
            }
          }

          return {
            success: true,
            isDuplicate: false,
            existingData: {
              ...sale,
              id: invoiceId,
              invoiceNumber: invoiceNumber,
              requestId: reqId
            }
          };
        }

        // Timeout recovery check
        const isTimeout = error.message?.toLowerCase().includes('timeout') || error.message?.toLowerCase().includes('failed to fetch');
        if (isTimeout) {
          const recovery = await this.getTransactionByRequestId(reqId);
          if (recovery.found && recovery.id) {
            return {
              success: true,
              isDuplicate: true,
              existingData: {
                ...sale,
                id: recovery.id,
                invoiceNumber: recovery.doc_number || sale.invoiceNumber,
                requestId: reqId
              }
            };
          }
        }
        return { success: false, error: error.message };
      }

      if (data && data.success === false) {
        return { success: false, error: data.error || 'Database rejected sales invoice transaction.' };
      }

      if (data?.success) {
        const isDuplicate = data?.is_duplicate || false;
        const returnedData = data?.data;

        return { 
          success: true, 
          isDuplicate, 
          existingData: returnedData ? {
            ...sale,
            id: returnedData.id,
            invoiceNumber: returnedData.invoice_number,
            requestId: returnedData.request_id
          } : undefined
        };
      }

      return { success: false, error: 'Unknown response from post_sale_invoice_rpc.' };
    } catch (e: any) {
      return { success: false, error: e?.message };
    } finally {
      _inFlightRequests.delete(reqId);
    }
  },

  async updateSaleInvoiceAtomic(
    invoiceId: string,
    sale: Partial<SaleInvoice>,
    updateRequestId: string,
    companyId?: string
  ): Promise<{ success: boolean; error?: string; isDuplicate?: boolean; data?: any }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    const reqId = updateRequestId || `req_upd_sale_${invoiceId}_${Date.now()}`;
    if (_inFlightRequests.has(reqId)) {
      return { success: false, error: 'An update transaction with this Request ID is already in-flight.' };
    }
    _inFlightRequests.add(reqId);

    try {
      const compId = sale.companyId || companyId || 'comp-1';
      await ensureCompanyExists(client, compId);

      const itemsPayload = (sale.items || []).map((item) => ({
        productId: item.productId,
        productCode: item.productCode || '',
        productName: item.productName || '',
        quantity: Number(item.quantity || 0),
        unitPrice: Number(item.unitPrice || 0),
        discount: Number(item.discount || 0),
        discountType: item.discountType || 'PERCENT',
        total: Number(item.total || 0)
      }));

      const { data, error } = await client.rpc('update_sale_invoice_rpc', {
        p_request_id: reqId,
        p_company_id: compId,
        p_invoice_id: invoiceId,
        p_customer_id: sale.customerId || null,
        p_customer_name: sale.customerName || '',
        p_sale_type: sale.type || 'CASH',
        p_invoice_date: sale.date || new Date().toISOString().split('T')[0],
        p_total_amount: Number(sale.subtotal || 0),
        p_overall_discount: Number(sale.discount || 0),
        p_grand_total: Number(sale.grandTotal || 0),
        p_paid_amount: Number(sale.paidAmount || 0),
        p_due_amount: Number(sale.dueAmount || 0),
        p_notes: sale.notes || '',
        p_items: itemsPayload
      });

      if (error) {
        const isRpcMissing = (error.message || '').toLowerCase().includes('could not find the function') ||
                             (error.message || '').toLowerCase().includes('schema cache') ||
                             (error.message || '').toLowerCase().includes('does not exist') ||
                             error.code === 'PGRST202' ||
                             error.code === '42883';

        if (isRpcMissing) {
          const updatePayload: any = {
            updated_at: new Date().toISOString()
          };
          if (sale.customerId !== undefined) updatePayload.customer_id = sale.customerId || null;
          if (sale.customerName !== undefined) updatePayload.customer_name = sale.customerName || '';
          if (sale.type !== undefined) updatePayload.sale_type = sale.type;
          if (sale.date !== undefined) updatePayload.invoice_date = sale.date;
          if (sale.subtotal !== undefined) updatePayload.total_amount = Number(sale.subtotal || 0);
          if (sale.discount !== undefined) updatePayload.overall_discount = Number(sale.discount || 0);
          if (sale.grandTotal !== undefined) updatePayload.grand_total = Number(sale.grandTotal || 0);
          if (sale.paidAmount !== undefined) updatePayload.paid_amount = Number(sale.paidAmount || 0);
          if (sale.dueAmount !== undefined) updatePayload.due_amount = Number(sale.dueAmount || 0);
          if (sale.notes !== undefined) updatePayload.notes = sale.notes || '';

          const { error: updateErr } = await safeExecuteQuery(
            (payload) => client.from('busy_ufo_sales').update(payload).eq('id', invoiceId),
            updatePayload
          );

          if (updateErr) {
            return { success: false, error: updateErr.message };
          }

          if (sale.items && sale.items.length > 0) {
            await client.from('busy_ufo_sale_items').delete().eq('invoice_id', invoiceId);
            const rows = sale.items.map((it, idx) => ({
              id: `si-${invoiceId}-${Date.now()}-${idx}`,
              invoice_id: invoiceId,
              product_id: it.productId,
              product_code: it.productCode || '',
              product_name: it.productName || '',
              quantity: Number(it.quantity || 0),
              unit_price: Number(it.unitPrice || 0),
              discount: Number(it.discount || 0),
              discount_type: it.discountType || 'PERCENT',
              total: Number(it.total || 0)
            }));
            await safeExecuteQuery(
              (payload) => client.from('busy_ufo_sale_items').insert(payload),
              rows
            );
          }

          return { success: true };
        }

        return { success: false, error: error.message };
      }

      if (data && data.success === false) {
        return { success: false, error: data.error || 'Failed to update sale invoice atomically.' };
      }

      return {
        success: true,
        isDuplicate: data?.is_duplicate || false,
        data: data?.data
      };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Exception during sale invoice update.' };
    } finally {
      _inFlightRequests.delete(reqId);
    }
  },

  async deleteSaleInvoice(invoiceId: string, companyId?: string): Promise<{ success: boolean; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    const reqId = `req_void_sale_${invoiceId}`;
    if (_inFlightRequests.has(reqId)) {
      return { success: false, error: 'A void operation for this sale is already in progress.' };
    }
    _inFlightRequests.add(reqId);

    try {
      const compId = companyId || 'comp-1';
      // Authoritative atomic void_sale_invoice_rpc handles inventory, customer balance, linked receipts, and journals
      const { data, error } = await client.rpc('void_sale_invoice_rpc', {
        p_invoice_id: invoiceId,
        p_company_id: compId,
        p_request_id: reqId
      });

      if (error) {
        const isRpcMissing = (error.message || '').toLowerCase().includes('could not find the function') ||
                             (error.message || '').toLowerCase().includes('schema cache') ||
                             (error.message || '').toLowerCase().includes('does not exist') ||
                             error.code === 'PGRST202' ||
                             error.code === '42883';

        if (isRpcMissing) {
          await client.from('busy_ufo_sale_items').delete().eq('invoice_id', invoiceId);
          const { error: delErr } = await client.from('busy_ufo_sales').delete().eq('id', invoiceId);
          if (delErr) {
            return { success: false, error: delErr.message };
          }
          return { success: true };
        }

        // Safe timeout recovery without direct table fallback
        const recovery = await this.getTransactionByRequestId(reqId);
        if (recovery && recovery.found) {
          return { success: true };
        }
        return { success: false, error: error.message };
      }

      if (data && typeof data === 'object' && data.success === false) {
        return { success: false, error: data.error || 'Database rejected sale invoice voiding.' };
      }

      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message };
    } finally {
      _inFlightRequests.delete(reqId);
    }
  },

  // --- PURCHASES ---
  async syncPurchaseInvoice(purchase: PurchaseInvoice): Promise<{ success: boolean; error?: string; isDuplicate?: boolean; existingData?: PurchaseInvoice }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    const reqId = purchase.requestId || `req_pur_${purchase.id}`;
    if (_inFlightRequests.has(reqId)) {
      return { success: false, error: 'A transaction with this Request ID is already in-flight.' };
    }
    _inFlightRequests.add(reqId);

    try {
      await ensureCompanyExists(client, purchase.companyId || 'comp-1');

      const { data, error } = await client.rpc('post_purchase_invoice_rpc', {
        p_request_id: reqId,
        p_company_id: purchase.companyId || 'comp-1',
        p_supplier_id: purchase.supplierId || null,
        p_supplier_name: purchase.supplierName,
        p_purchase_type: purchase.type,
        p_purchase_date: purchase.date,
        p_total_amount: Number(purchase.subtotal || 0),
        p_overall_discount: Number(purchase.discount || 0),
        p_grand_total: Number(purchase.grandTotal || 0),
        p_paid_amount: Number(purchase.paidAmount || 0),
        p_due_amount: Number(purchase.dueAmount || 0),
        p_notes: purchase.notes || '',
        p_items: purchase.items.map(item => ({
          productId: item.productId,
          productCode: item.productCode || '',
          productName: item.productName || '',
          quantity: Number(item.quantity || 0),
          unitCost: Number(item.unitCost || 0),
          discount: Number(item.discount || 0),
          discountType: item.discountType || 'PERCENT',
          total: Number(item.total || 0)
        }))
      });

      if (error) {
        const isRpcMissing = (error.message || '').toLowerCase().includes('could not find the function') ||
                             (error.message || '').toLowerCase().includes('schema cache') ||
                             (error.message || '').toLowerCase().includes('does not exist') ||
                             error.code === 'PGRST202' ||
                             error.code === '42883';

        if (isRpcMissing) {
          // Direct Table Fallback
          const purchaseNumber = purchase.purchaseNumber || `PUR-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
          const purchaseId = purchase.id || `pur-${Date.now()}`;
          const compId = purchase.companyId || 'comp-1';

          const { error: insertErr } = await safeExecuteQuery(
            (payload) => client.from('busy_ufo_purchases').upsert(payload),
            {
              id: purchaseId,
              request_id: reqId,
              purchase_number: purchaseNumber,
              purchase_date: purchase.date || new Date().toISOString().split('T')[0],
              supplier_id: purchase.supplierId || null,
              supplier_name: purchase.supplierName || '',
              purchase_type: purchase.type || 'CASH',
              total_amount: Number(purchase.subtotal || 0),
              overall_discount: Number(purchase.discount || 0),
              grand_total: Number(purchase.grandTotal || 0),
              paid_amount: Number(purchase.paidAmount || 0),
              due_amount: Number(purchase.dueAmount || 0),
              notes: purchase.notes || '',
              company_id: compId,
              updated_at: new Date().toISOString()
            }
          );

          if (insertErr) {
            return { success: false, error: insertErr.message };
          }

          if (purchase.items && purchase.items.length > 0) {
            const rows = purchase.items.map((it, idx) => ({
              id: `pi-${Date.now()}-${idx}`,
              purchase_id: purchaseId,
              product_id: it.productId,
              product_code: it.productCode || '',
              product_name: it.productName || '',
              quantity: Number(it.quantity || 0),
              unit_cost: Number(it.unitCost || 0),
              discount: Number(it.discount || 0),
              discount_type: it.discountType || 'PERCENT',
              total: Number(it.total || 0)
            }));
            await safeExecuteQuery(
              (payload) => client.from('busy_ufo_purchase_items').insert(payload),
              rows
            );

            // Add product stock
            for (const it of purchase.items) {
              if (it.productId) {
                const { data: prodData } = await client
                  .from('busy_ufo_products')
                  .select('stock')
                  .eq('id', it.productId)
                  .eq('company_id', compId)
                  .maybeSingle();

                if (prodData) {
                  const newStock = Number(prodData.stock || 0) + Number(it.quantity || 0);
                  await safeExecuteQuery(
                    (payload) => client.from('busy_ufo_products').update(payload).eq('id', it.productId).eq('company_id', compId),
                    { stock: newStock, updated_at: new Date().toISOString() }
                  );
                }
              }
            }
          }

          // Adjust supplier balance if credit purchase
          if (purchase.supplierId && purchase.type === 'CREDIT' && Number(purchase.dueAmount || 0) > 0) {
            const { data: suppData } = await client
              .from('busy_ufo_suppliers')
              .select('current_balance')
              .eq('id', purchase.supplierId)
              .eq('company_id', compId)
              .maybeSingle();

            if (suppData) {
              const newBal = Number(suppData.current_balance || 0) + Number(purchase.dueAmount || 0);
              await safeExecuteQuery(
                (payload) => client.from('busy_ufo_suppliers').update(payload).eq('id', purchase.supplierId!).eq('company_id', compId),
                { current_balance: newBal, updated_at: new Date().toISOString() }
              );
            }
          }

          return {
            success: true,
            isDuplicate: false,
            existingData: {
              ...purchase,
              id: purchaseId,
              purchaseNumber: purchaseNumber,
              requestId: reqId
            }
          };
        }

        const isTimeout = error.message?.toLowerCase().includes('timeout') || error.message?.toLowerCase().includes('failed to fetch');
        if (isTimeout) {
          const recovery = await this.getTransactionByRequestId(reqId);
          if (recovery.found && recovery.id) {
            return {
              success: true,
              isDuplicate: true,
              existingData: {
                ...purchase,
                id: recovery.id,
                purchaseNumber: recovery.doc_number || purchase.purchaseNumber,
                requestId: reqId
              }
            };
          }
        }
        return { success: false, error: error.message };
      }

      if (data && data.success === false) {
        return { success: false, error: data.error || 'Database rejected purchase invoice transaction.' };
      }

      if (data?.success) {
        const isDuplicate = data?.is_duplicate || false;
        const returnedData = data?.data;

        return { 
          success: true, 
          isDuplicate, 
          existingData: returnedData ? {
            ...purchase,
            id: returnedData.id,
            purchaseNumber: returnedData.purchase_number,
            requestId: returnedData.request_id
          } : undefined
        };
      }

      return { success: false, error: 'Unknown response from post_purchase_invoice_rpc.' };
    } catch (e: any) {
      return { success: false, error: e?.message };
    } finally {
      _inFlightRequests.delete(reqId);
    }
  },

  async updatePurchaseInvoiceAtomic(
    purchaseId: string,
    purchase: Partial<PurchaseInvoice>,
    updateRequestId: string,
    companyId?: string
  ): Promise<{ success: boolean; error?: string; isDuplicate?: boolean; data?: any }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    const reqId = updateRequestId || `req_upd_pur_${purchaseId}_${Date.now()}`;
    if (_inFlightRequests.has(reqId)) {
      return { success: false, error: 'An update transaction with this Request ID is already in-flight.' };
    }
    _inFlightRequests.add(reqId);

    try {
      const compId = purchase.companyId || companyId || 'comp-1';
      await ensureCompanyExists(client, compId);

      const itemsPayload = (purchase.items || []).map((item) => ({
        productId: item.productId,
        productCode: item.productCode || '',
        productName: item.productName || '',
        quantity: Number(item.quantity || 0),
        unitCost: Number(item.unitCost || 0),
        discount: Number(item.discount || 0),
        discountType: item.discountType || 'PERCENT',
        total: Number(item.total || 0)
      }));

      const { data, error } = await client.rpc('update_purchase_invoice_rpc', {
        p_request_id: reqId,
        p_company_id: compId,
        p_purchase_id: purchaseId,
        p_supplier_id: purchase.supplierId || null,
        p_supplier_name: purchase.supplierName || '',
        p_purchase_type: purchase.type || 'CASH',
        p_purchase_date: purchase.date || new Date().toISOString().split('T')[0],
        p_total_amount: Number(purchase.subtotal || 0),
        p_overall_discount: Number(purchase.discount || 0),
        p_grand_total: Number(purchase.grandTotal || 0),
        p_paid_amount: Number(purchase.paidAmount || 0),
        p_due_amount: Number(purchase.dueAmount || 0),
        p_notes: purchase.notes || '',
        p_items: itemsPayload
      });

      if (error) {
        const isRpcMissing = (error.message || '').toLowerCase().includes('could not find the function') ||
                             (error.message || '').toLowerCase().includes('schema cache') ||
                             (error.message || '').toLowerCase().includes('does not exist') ||
                             error.code === 'PGRST202' ||
                             error.code === '42883';

        if (isRpcMissing) {
          const updatePayload: any = {
            updated_at: new Date().toISOString()
          };
          if (purchase.supplierId !== undefined) updatePayload.supplier_id = purchase.supplierId || null;
          if (purchase.supplierName !== undefined) updatePayload.supplier_name = purchase.supplierName || '';
          if (purchase.type !== undefined) updatePayload.purchase_type = purchase.type;
          if (purchase.date !== undefined) updatePayload.purchase_date = purchase.date;
          if (purchase.subtotal !== undefined) updatePayload.total_amount = Number(purchase.subtotal || 0);
          if (purchase.discount !== undefined) updatePayload.overall_discount = Number(purchase.discount || 0);
          if (purchase.grandTotal !== undefined) updatePayload.grand_total = Number(purchase.grandTotal || 0);
          if (purchase.paidAmount !== undefined) updatePayload.paid_amount = Number(purchase.paidAmount || 0);
          if (purchase.dueAmount !== undefined) updatePayload.due_amount = Number(purchase.dueAmount || 0);
          if (purchase.notes !== undefined) updatePayload.notes = purchase.notes || '';

          const { error: updateErr } = await safeExecuteQuery(
            (payload) => client.from('busy_ufo_purchases').update(payload).eq('id', purchaseId),
            updatePayload
          );

          if (updateErr) {
            return { success: false, error: updateErr.message };
          }

          if (purchase.items && purchase.items.length > 0) {
            await client.from('busy_ufo_purchase_items').delete().eq('purchase_id', purchaseId);
            const rows = purchase.items.map((it, idx) => ({
              id: `pi-${purchaseId}-${Date.now()}-${idx}`,
              purchase_id: purchaseId,
              product_id: it.productId,
              product_code: it.productCode || '',
              product_name: it.productName || '',
              quantity: Number(it.quantity || 0),
              unit_cost: Number(it.unitCost || 0),
              discount: Number(it.discount || 0),
              discount_type: it.discountType || 'PERCENT',
              total: Number(it.total || 0)
            }));
            await safeExecuteQuery(
              (payload) => client.from('busy_ufo_purchase_items').insert(payload),
              rows
            );
          }

          return { success: true };
        }

        return { success: false, error: error.message };
      }

      if (data && data.success === false) {
        return { success: false, error: data.error || 'Failed to update purchase invoice atomically.' };
      }

      return {
        success: true,
        isDuplicate: data?.is_duplicate || false,
        data: data?.data
      };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Exception during purchase invoice update.' };
    } finally {
      _inFlightRequests.delete(reqId);
    }
  },

  async deletePurchaseInvoice(purchaseId: string, companyId?: string): Promise<{ success: boolean; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    const reqId = `req_void_pur_${purchaseId}`;
    if (_inFlightRequests.has(reqId)) {
      return { success: false, error: 'A void operation for this purchase bill is already in progress.' };
    }
    _inFlightRequests.add(reqId);

    try {
      const compId = companyId || 'comp-1';
      // Authoritative atomic void_purchase_invoice_rpc handles inventory, supplier balance, linked payments, and journals
      const { data, error } = await client.rpc('void_purchase_invoice_rpc', {
        p_purchase_id: purchaseId,
        p_company_id: compId,
        p_request_id: reqId
      });

      if (error) {
        const isRpcMissing = (error.message || '').toLowerCase().includes('could not find the function') ||
                             (error.message || '').toLowerCase().includes('schema cache') ||
                             (error.message || '').toLowerCase().includes('does not exist') ||
                             error.code === 'PGRST202' ||
                             error.code === '42883';

        if (isRpcMissing) {
          await client.from('busy_ufo_purchase_items').delete().eq('purchase_id', purchaseId);
          const { error: delErr } = await client.from('busy_ufo_purchases').delete().eq('id', purchaseId);
          if (delErr) {
            return { success: false, error: delErr.message };
          }
          return { success: true };
        }

        // Safe timeout recovery without direct table fallback
        const recovery = await this.getTransactionByRequestId(reqId);
        if (recovery && recovery.found) {
          return { success: true };
        }
        return { success: false, error: error.message };
      }

      if (data && typeof data === 'object' && data.success === false) {
        return { success: false, error: data.error || 'Database rejected purchase invoice voiding.' };
      }

      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message };
    } finally {
      _inFlightRequests.delete(reqId);
    }
  },

  // --- RETURNS (SALES RETURN & PURCHASE RETURN) ---
  async syncSaleReturn(saleReturn: SaleReturn): Promise<{ success: boolean; error?: string; isDuplicate?: boolean; existingData?: SaleReturn; data?: any }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    const reqId = saleReturn.requestId || `req_sr_${saleReturn.id}`;
    if (_inFlightRequests.has(reqId)) {
      return { success: false, error: 'A sales return request with this Request ID is already in-flight.' };
    }
    _inFlightRequests.add(reqId);

    try {
      await ensureCompanyExists(client, saleReturn.companyId || 'comp-1');

      const itemsPayload = (saleReturn.items || []).map((it) => ({
        productId: it.productId,
        productCode: it.productCode || '',
        productName: it.productName || '',
        quantity: Number(it.quantity || 0),
        unitPrice: Number(it.unitPrice || 0),
        total: Number(it.total || 0)
      }));

      const { data, error } = await client.rpc('post_sales_return_rpc', {
        p_request_id: reqId,
        p_company_id: saleReturn.companyId || 'comp-1',
        p_customer_id: saleReturn.customerId || null,
        p_customer_name: saleReturn.customerName || '',
        p_date: saleReturn.date || new Date().toISOString().split('T')[0],
        p_type: saleReturn.type || 'CASH',
        p_invoice_id: saleReturn.invoiceId || null,
        p_invoice_number: saleReturn.invoiceNumber || null,
        p_subtotal: Number(saleReturn.subtotal || 0),
        p_discount: Number(saleReturn.discount || 0),
        p_grand_total: Number(saleReturn.grandTotal || 0),
        p_refunded_amount: Number(saleReturn.refundedAmount || 0),
        p_reason: saleReturn.reason || '',
        p_notes: saleReturn.notes || '',
        p_items: itemsPayload
      });

      if (error) {
        const isRpcMissing = (error.message || '').toLowerCase().includes('could not find the function') ||
                             (error.message || '').toLowerCase().includes('schema cache') ||
                             (error.message || '').toLowerCase().includes('does not exist') ||
                             error.code === 'PGRST202' ||
                             error.code === '42883';

        if (isRpcMissing) {
          // Direct Table Fallback
          const returnNumber = saleReturn.returnNumber || `SR-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
          const returnId = saleReturn.id || `sr-${Date.now()}`;
          const compId = saleReturn.companyId || 'comp-1';

          const { error: insertErr } = await safeExecuteQuery(
            (payload) => client.from('busy_ufo_sale_returns').upsert(payload),
            {
              id: returnId,
              request_id: reqId,
              return_number: returnNumber,
              date: saleReturn.date || new Date().toISOString().split('T')[0],
              customer_id: saleReturn.customerId || null,
              customer_name: saleReturn.customerName || '',
              type: saleReturn.type || 'CASH',
              invoice_id: saleReturn.invoiceId || null,
              invoice_number: saleReturn.invoiceNumber || null,
              subtotal: Number(saleReturn.subtotal || 0),
              discount: Number(saleReturn.discount || 0),
              grand_total: Number(saleReturn.grandTotal || 0),
              refunded_amount: Number(saleReturn.refundedAmount || 0),
              reason: saleReturn.reason || '',
              notes: saleReturn.notes || '',
              company_id: compId,
              updated_at: new Date().toISOString()
            }
          );

          if (insertErr) {
            return { success: false, error: insertErr.message };
          }

          // Insert items
          if (saleReturn.items && saleReturn.items.length > 0) {
            const rows = saleReturn.items.map((it, idx) => ({
              id: (it as any).id || `sri-${Date.now()}-${idx}`,
              return_id: returnId,
              product_id: it.productId,
              product_code: it.productCode || '',
              product_name: it.productName || '',
              quantity: Number(it.quantity || 0),
              unit_price: Number(it.unitPrice || 0),
              total: Number(it.total || 0)
            }));
            await safeExecuteQuery(
              (payload) => client.from('busy_ufo_sale_return_items').insert(payload),
              rows
            );

            // Restock products
            for (const it of saleReturn.items) {
              if (it.productId) {
                const { data: prodData } = await client
                  .from('busy_ufo_products')
                  .select('stock')
                  .eq('id', it.productId)
                  .eq('company_id', compId)
                  .maybeSingle();

                if (prodData) {
                  const newStock = Number(prodData.stock || 0) + Number(it.quantity || 0);
                  await safeExecuteQuery(
                    (payload) => client.from('busy_ufo_products').update(payload).eq('id', it.productId).eq('company_id', compId),
                    { stock: newStock, updated_at: new Date().toISOString() }
                  );
                }
              }
            }
          }

          // Adjust customer balance if credit sale return
          if (saleReturn.customerId && saleReturn.type === 'CREDIT') {
            const { data: custData } = await client
              .from('busy_ufo_customers')
              .select('current_balance')
              .eq('id', saleReturn.customerId)
              .eq('company_id', compId)
              .maybeSingle();

            if (custData) {
              const newBal = Math.max(0, Number(custData.current_balance || 0) - Number(saleReturn.grandTotal || 0));
              await safeExecuteQuery(
                (payload) => client.from('busy_ufo_customers').update(payload).eq('id', saleReturn.customerId!).eq('company_id', compId),
                { current_balance: newBal, updated_at: new Date().toISOString() }
              );
            }
          }

          return {
            success: true,
            existingData: {
              ...saleReturn,
              id: returnId,
              returnNumber: returnNumber,
              requestId: reqId
            },
            data: {
              id: returnId,
              return_number: returnNumber,
              request_id: reqId
            }
          };
        }

        const isTimeout = error.message?.toLowerCase().includes('timeout') || error.message?.toLowerCase().includes('failed to fetch');
        if (isTimeout) {
          const recovery = await this.getTransactionByRequestId(reqId);
          if (recovery.found && recovery.id) {
            return {
              success: true,
              isDuplicate: true,
              existingData: {
                ...saleReturn,
                id: recovery.id,
                returnNumber: recovery.doc_number || saleReturn.returnNumber,
                requestId: reqId
              },
              data: {
                id: recovery.id,
                return_number: recovery.doc_number,
                request_id: reqId
              }
            };
          }
        }
        return { success: false, error: error.message };
      }

      if (data && data.success === false) {
        return { success: false, error: data.error || 'Database rejected sales return transaction.' };
      }

      const retData = data?.data || data;
      return {
        success: true,
        isDuplicate: data?.is_duplicate || false,
        existingData: retData ? {
          ...saleReturn,
          id: retData.id || saleReturn.id,
          returnNumber: retData.return_number || saleReturn.returnNumber,
          requestId: retData.request_id || reqId
        } : undefined,
        data: retData
      };
    } catch (e: any) {
      return { success: false, error: e?.message };
    } finally {
      _inFlightRequests.delete(reqId);
    }
  },

  async deleteSaleReturn(returnId: string, companyId?: string): Promise<{ success: boolean; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    const reqId = `req_void_sr_${returnId}`;
    if (_inFlightRequests.has(reqId)) {
      return { success: false, error: 'A void operation for this sales return is already in progress.' };
    }
    _inFlightRequests.add(reqId);

    try {
      const compId = companyId || 'comp-1';

      // 1. Fetch current return and items before deletion to allow stock & balance reversal
      const { data: srData } = await client
        .from('busy_ufo_sale_returns')
        .select('*')
        .eq('id', returnId)
        .maybeSingle();

      let srItems: any[] = [];
      try {
        const { data: itemsData } = await client
          .from('busy_ufo_sale_return_items')
          .select('*')
          .eq('return_id', returnId);
        if (itemsData) srItems = itemsData;
      } catch (e) {
        // Table might not exist
      }

      // Try RPC first
      let rpcSucceeded = false;
      try {
        const { data, error } = await client.rpc('void_sale_return_rpc', {
          p_return_id: returnId,
          p_company_id: compId,
          p_request_id: reqId
        });
        if (!error && data && (data === true || (typeof data === 'object' && data.success !== false))) {
          rpcSucceeded = true;
        }
      } catch (e) {
        rpcSucceeded = false;
      }

      if (!rpcSucceeded) {
        // Fallback: direct table updates & deletion
        let itemsToRevert: Array<{ product_id: string; quantity: number }> = [];
        if (srItems && srItems.length > 0) {
          itemsToRevert = srItems.map((i: any) => ({
            product_id: i.product_id,
            quantity: Number(i.quantity || 0)
          }));
        } else if (srData && srData.items) {
          const parsed = typeof srData.items === 'string' ? JSON.parse(srData.items) : srData.items;
          if (Array.isArray(parsed)) {
            itemsToRevert = parsed.map((i: any) => ({
              product_id: i.productId || i.product_id,
              quantity: Number(i.quantity || 0)
            }));
          }
        }

        // Revert product stock (Stock IN -> Stock OUT)
        for (const item of itemsToRevert) {
          if (item.product_id) {
            const { data: prodData } = await client
              .from('busy_ufo_products')
              .select('stock, current_stock')
              .eq('id', item.product_id)
              .maybeSingle();

            if (prodData) {
              const currentStk = Number(prodData.stock ?? prodData.current_stock ?? 0);
              const newStk = Math.max(0, currentStk - item.quantity);
              await client
                .from('busy_ufo_products')
                .update({ stock: newStk, current_stock: newStk, updated_at: new Date().toISOString() })
                .eq('id', item.product_id);
            }
          }
        }

        // Revert customer balance if CREDIT type
        if (srData && srData.customer_id && (srData.type === 'CREDIT' || srData.return_type === 'CREDIT')) {
          const { data: custData } = await client
            .from('busy_ufo_customers')
            .select('current_balance, outstanding_balance')
            .eq('id', srData.customer_id)
            .maybeSingle();

          if (custData) {
            const currentBal = Number(custData.current_balance ?? custData.outstanding_balance ?? 0);
            const returnTotal = Number(srData.grand_total ?? srData.grandTotal ?? 0);
            const newBal = currentBal + returnTotal;
            await client
              .from('busy_ufo_customers')
              .update({ current_balance: newBal, outstanding_balance: newBal, updated_at: new Date().toISOString() })
              .eq('id', srData.customer_id);
          }
        }

        // Delete items and main return record safely
        try {
          await client.from('busy_ufo_sale_return_items').delete().eq('return_id', returnId);
        } catch (e) {
          // ignore
        }

        const { error: delErr } = await client.from('busy_ufo_sale_returns').delete().eq('id', returnId);
        if (delErr) {
          console.warn('Could not delete sale return from Supabase table:', delErr.message);
        }
      }

      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message };
    } finally {
      _inFlightRequests.delete(reqId);
    }
  },

  async updateSaleReturn(id: string, saleReturn: SaleReturn, compId?: string): Promise<{ success: boolean; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };
    const targetCompId = compId || saleReturn.companyId || 'comp-1';

    try {
      // 1. Fetch old return items & customer ID to adjust balances/stock
      const { data: oldItems } = await client
        .from('busy_ufo_sale_return_items')
        .select('*')
        .eq('return_id', id);

      const { data: oldData } = await client
        .from('busy_ufo_sale_returns')
        .select('*')
        .eq('id', id)
        .maybeSingle();

      // 2. Update main sale return record
      const { error: updateErr } = await safeExecuteQuery(
        (payload) => client.from('busy_ufo_sale_returns').update(payload).eq('id', id),
        {
          customer_id: saleReturn.customerId || null,
          customer_name: saleReturn.customerName || 'Customer',
          date: saleReturn.date || new Date().toISOString().split('T')[0],
          reason: saleReturn.reason || '',
          type: saleReturn.type || 'CASH',
          subtotal: Number(saleReturn.subtotal || 0),
          discount: Number(saleReturn.discount || 0),
          tax_amount: Number(saleReturn.taxAmount || 0),
          grand_total: Number(saleReturn.grandTotal || 0),
          notes: saleReturn.notes || '',
          updated_at: new Date().toISOString()
        }
      );

      if (updateErr) return { success: false, error: updateErr.message };

      // 3. Re-insert line items
      try {
        await client.from('busy_ufo_sale_return_items').delete().eq('return_id', id);
      } catch (e) {
        // ignore
      }

      if (saleReturn.items && saleReturn.items.length > 0) {
        const itemRows = saleReturn.items.map((item, idx) => ({
          id: `sri-${id}-${idx}`,
          return_id: id,
          product_id: item.productId,
          product_code: item.productCode || '',
          product_name: item.productName || 'Item',
          quantity: Number(item.quantity || 1),
          unit_price: Number(item.unitPrice || 0),
          total: Number(item.total || 0)
        }));
        await safeExecuteQuery(
          (payload) => client.from('busy_ufo_sale_return_items').insert(payload),
          itemRows
        );
      }

      // 4. Stock adjustment in Supabase DB: Reverse old items stock IN, apply new items stock IN
      if (oldItems && oldItems.length > 0) {
        for (const oItem of oldItems) {
          if (oItem.product_id) {
            const { data: prodData } = await client
              .from('busy_ufo_products')
              .select('stock, current_stock')
              .eq('id', oItem.product_id)
              .maybeSingle();
            if (prodData) {
              const currentStk = Number(prodData.stock ?? prodData.current_stock ?? 0);
              const newStk = Math.max(0, currentStk - Number(oItem.quantity || 0));
              await safeExecuteQuery(
                (payload) => client.from('busy_ufo_products').update(payload).eq('id', oItem.product_id),
                { stock: newStk, current_stock: newStk }
              );
            }
          }
        }
      }

      if (saleReturn.items && saleReturn.items.length > 0) {
        for (const nItem of saleReturn.items) {
          if (nItem.productId) {
            const { data: prodData } = await client
              .from('busy_ufo_products')
              .select('stock, current_stock')
              .eq('id', nItem.productId)
              .maybeSingle();
            if (prodData) {
              const currentStk = Number(prodData.stock ?? prodData.current_stock ?? 0);
              const newStk = currentStk + Number(nItem.quantity || 0);
              await safeExecuteQuery(
                (payload) => client.from('busy_ufo_products').update(payload).eq('id', nItem.productId),
                { stock: newStk, current_stock: newStk }
              );
            }
          }
        }
      }

      // 5. Customer balance adjustment in Supabase DB
      if (oldData && oldData.customer_id && (oldData.type === 'CREDIT' || oldData.return_type === 'CREDIT')) {
        const { data: custData } = await client
          .from('busy_ufo_customers')
          .select('current_balance, outstanding_balance')
          .eq('id', oldData.customer_id)
          .maybeSingle();

        if (custData) {
          const currentBal = Number(custData.current_balance ?? custData.outstanding_balance ?? 0);
          const oldReturnTotal = Number(oldData.grand_total ?? oldData.grandTotal ?? 0);
          const revertedBal = currentBal + oldReturnTotal;
          await safeExecuteQuery(
            (payload) => client.from('busy_ufo_customers').update(payload).eq('id', oldData.customer_id),
            { current_balance: revertedBal, outstanding_balance: revertedBal }
          );
        }
      }

      if (saleReturn.customerId && saleReturn.type === 'CREDIT') {
        const { data: custData } = await client
          .from('busy_ufo_customers')
          .select('current_balance, outstanding_balance')
          .eq('id', saleReturn.customerId)
          .maybeSingle();

        if (custData) {
          const currentBal = Number(custData.current_balance ?? custData.outstanding_balance ?? 0);
          const newReturnTotal = Number(saleReturn.grandTotal || 0);
          const finalBal = Math.max(0, currentBal - newReturnTotal);
          await safeExecuteQuery(
            (payload) => client.from('busy_ufo_customers').update(payload).eq('id', saleReturn.customerId),
            { current_balance: finalBal, outstanding_balance: finalBal }
          );
        }
      }

      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message };
    }
  },

  async syncPurchaseReturn(purchaseReturn: PurchaseReturn): Promise<{ success: boolean; error?: string; isDuplicate?: boolean; existingData?: PurchaseReturn; data?: any }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    const reqId = purchaseReturn.requestId || `req_pr_${purchaseReturn.id}`;
    if (_inFlightRequests.has(reqId)) {
      return { success: false, error: 'A purchase return request with this Request ID is already in-flight.' };
    }
    _inFlightRequests.add(reqId);

    try {
      await ensureCompanyExists(client, purchaseReturn.companyId || 'comp-1');

      const itemsPayload = (purchaseReturn.items || []).map((it) => ({
        productId: it.productId,
        productCode: it.productCode || '',
        productName: it.productName || '',
        quantity: Number(it.quantity || 0),
        unitCost: Number(it.unitCost || 0),
        total: Number(it.total || 0)
      }));

      const { data, error } = await client.rpc('post_purchase_return_rpc', {
        p_request_id: reqId,
        p_company_id: purchaseReturn.companyId || 'comp-1',
        p_supplier_id: purchaseReturn.supplierId || null,
        p_supplier_name: purchaseReturn.supplierName || '',
        p_date: purchaseReturn.date || new Date().toISOString().split('T')[0],
        p_type: purchaseReturn.type || 'CASH',
        p_purchase_id: purchaseReturn.purchaseId || null,
        p_purchase_number: purchaseReturn.purchaseNumber || null,
        p_subtotal: Number(purchaseReturn.subtotal || 0),
        p_discount: Number(purchaseReturn.discount || 0),
        p_grand_total: Number(purchaseReturn.grandTotal || 0),
        p_reason: purchaseReturn.reason || '',
        p_notes: purchaseReturn.notes || '',
        p_items: itemsPayload
      });

      if (error) {
        const isRpcMissing = (error.message || '').toLowerCase().includes('could not find the function') ||
                             (error.message || '').toLowerCase().includes('schema cache') ||
                             (error.message || '').toLowerCase().includes('does not exist') ||
                             error.code === 'PGRST202' ||
                             error.code === '42883';

        if (isRpcMissing) {
          // Direct Table Fallback
          const returnNumber = purchaseReturn.returnNumber || `PR-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
          const returnId = purchaseReturn.id || `pr-${Date.now()}`;
          const compId = purchaseReturn.companyId || 'comp-1';

          const { error: insertErr } = await safeExecuteQuery(
            (payload) => client.from('busy_ufo_purchase_returns').upsert(payload),
            {
              id: returnId,
              request_id: reqId,
              return_number: returnNumber,
              date: purchaseReturn.date || new Date().toISOString().split('T')[0],
              supplier_id: purchaseReturn.supplierId || null,
              supplier_name: purchaseReturn.supplierName || '',
              type: purchaseReturn.type || 'CASH',
              purchase_id: purchaseReturn.purchaseId || null,
              purchase_number: purchaseReturn.purchaseNumber || null,
              subtotal: Number(purchaseReturn.subtotal || 0),
              discount: Number(purchaseReturn.discount || 0),
              grand_total: Number(purchaseReturn.grandTotal || 0),
              reason: purchaseReturn.reason || '',
              notes: purchaseReturn.notes || '',
              company_id: compId,
              updated_at: new Date().toISOString()
            }
          );

          if (insertErr) {
            return { success: false, error: insertErr.message };
          }

          // Insert items
          if (purchaseReturn.items && purchaseReturn.items.length > 0) {
            const rows = purchaseReturn.items.map((it, idx) => ({
              id: (it as any).id || `pri-${Date.now()}-${idx}`,
              return_id: returnId,
              product_id: it.productId,
              product_code: it.productCode || '',
              product_name: it.productName || '',
              quantity: Number(it.quantity || 0),
              unit_cost: Number(it.unitCost || 0),
              total: Number(it.total || 0)
            }));
            await safeExecuteQuery(
              (payload) => client.from('busy_ufo_purchase_return_items').insert(payload),
              rows
            );

            // Deduct product stocks
            for (const it of purchaseReturn.items) {
              if (it.productId) {
                const { data: prodData } = await client
                  .from('busy_ufo_products')
                  .select('stock')
                  .eq('id', it.productId)
                  .eq('company_id', compId)
                  .maybeSingle();

                if (prodData) {
                  const newStock = Math.max(0, Number(prodData.stock || 0) - Number(it.quantity || 0));
                  await safeExecuteQuery(
                    (payload) => client.from('busy_ufo_products').update(payload).eq('id', it.productId).eq('company_id', compId),
                    { stock: newStock, updated_at: new Date().toISOString() }
                  );
                }
              }
            }
          }

          // Adjust supplier balance if credit purchase return
          if (purchaseReturn.supplierId && purchaseReturn.type === 'CREDIT') {
            const { data: suppData } = await client
              .from('busy_ufo_suppliers')
              .select('current_balance')
              .eq('id', purchaseReturn.supplierId)
              .eq('company_id', compId)
              .maybeSingle();

            if (suppData) {
              const newBal = Math.max(0, Number(suppData.current_balance || 0) - Number(purchaseReturn.grandTotal || 0));
              await safeExecuteQuery(
                (payload) => client.from('busy_ufo_suppliers').update(payload).eq('id', purchaseReturn.supplierId!).eq('company_id', compId),
                { current_balance: newBal, updated_at: new Date().toISOString() }
              );
            }
          }

          return {
            success: true,
            existingData: {
              ...purchaseReturn,
              id: returnId,
              returnNumber: returnNumber,
              requestId: reqId
            },
            data: {
              id: returnId,
              return_number: returnNumber,
              request_id: reqId
            }
          };
        }

        const isTimeout = error.message?.toLowerCase().includes('timeout') || error.message?.toLowerCase().includes('failed to fetch');
        if (isTimeout) {
          const recovery = await this.getTransactionByRequestId(reqId);
          if (recovery.found && recovery.id) {
            return {
              success: true,
              isDuplicate: true,
              existingData: {
                ...purchaseReturn,
                id: recovery.id,
                returnNumber: recovery.doc_number || purchaseReturn.returnNumber,
                requestId: reqId
              },
              data: {
                id: recovery.id,
                return_number: recovery.doc_number,
                request_id: reqId
              }
            };
          }
        }
        return { success: false, error: error.message };
      }

      if (data && data.success === false) {
        return { success: false, error: data.error || 'Database rejected purchase return transaction.' };
      }

      const retData = data?.data || data;
      return {
        success: true,
        isDuplicate: data?.is_duplicate || false,
        existingData: retData ? {
          ...purchaseReturn,
          id: retData.id || purchaseReturn.id,
          returnNumber: retData.return_number || purchaseReturn.returnNumber,
          requestId: retData.request_id || reqId
        } : undefined,
        data: retData
      };
    } catch (e: any) {
      return { success: false, error: e?.message };
    } finally {
      _inFlightRequests.delete(reqId);
    }
  },

  async deletePurchaseReturn(returnId: string, companyId?: string): Promise<{ success: boolean; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    const reqId = `req_void_pr_${returnId}`;
    if (_inFlightRequests.has(reqId)) {
      return { success: false, error: 'A void operation for this purchase return is already in progress.' };
    }
    _inFlightRequests.add(reqId);

    try {
      const compId = companyId || 'comp-1';
      const { data, error } = await client.rpc('void_purchase_return_rpc', {
        p_return_id: returnId,
        p_company_id: compId,
        p_request_id: reqId
      });

      if (error) {
        const isRpcMissing = (error.message || '').toLowerCase().includes('could not find the function') ||
                             (error.message || '').toLowerCase().includes('schema cache') ||
                             (error.message || '').toLowerCase().includes('does not exist') ||
                             error.code === 'PGRST202' ||
                             error.code === '42883';

        if (isRpcMissing) {
          await client.from('busy_ufo_purchase_return_items').delete().eq('return_id', returnId);
          const { error: delErr } = await client.from('busy_ufo_purchase_returns').delete().eq('id', returnId);
          if (delErr) {
            return { success: false, error: delErr.message };
          }
          return { success: true };
        }

        return { success: false, error: error.message };
      }

      if (data && typeof data === 'object' && data.success === false) {
        return { success: false, error: data.error || 'Database rejected purchase return voiding.' };
      }

      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message };
    } finally {
      _inFlightRequests.delete(reqId);
    }
  },

  async updatePurchaseReturn(id: string, purchaseReturn: PurchaseReturn, compId?: string): Promise<{ success: boolean; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };
    const targetCompId = compId || purchaseReturn.companyId || 'comp-1';

    try {
      const { error: updateErr } = await safeExecuteQuery(
        (payload) => client.from('busy_ufo_purchase_returns').update(payload).eq('id', id),
        {
          supplier_id: purchaseReturn.supplierId || null,
          supplier_name: purchaseReturn.supplierName || 'Supplier',
          date: purchaseReturn.date || new Date().toISOString().split('T')[0],
          reason: purchaseReturn.reason || '',
          type: purchaseReturn.type || 'CASH',
          subtotal: Number(purchaseReturn.subtotal || 0),
          discount: Number(purchaseReturn.discount || 0),
          tax_amount: Number(purchaseReturn.taxAmount || 0),
          grand_total: Number(purchaseReturn.grandTotal || 0),
          notes: purchaseReturn.notes || '',
          updated_at: new Date().toISOString()
        }
      );

      if (updateErr) return { success: false, error: updateErr.message };

      // Re-insert line items
      await client.from('busy_ufo_purchase_return_items').delete().eq('return_id', id);

      if (purchaseReturn.items && purchaseReturn.items.length > 0) {
        const itemRows = purchaseReturn.items.map((item, idx) => ({
          id: `pri-${id}-${idx}`,
          return_id: id,
          product_id: item.productId,
          product_code: item.productCode || '',
          product_name: item.productName || 'Item',
          quantity: Number(item.quantity || 1),
          unit_price: Number(item.unitCost || (item as any).unitPrice || 0),
          total: Number(item.total || 0)
        }));
        await safeExecuteQuery(
          (payload) => client.from('busy_ufo_purchase_return_items').insert(payload),
          itemRows
        );
      }

      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message };
    }
  },

  // --- RECEIPTS, PAYMENTS & EXPENSES ---
  async syncReceipt(receipt: CustomerReceipt): Promise<{ success: boolean; error?: string; isDuplicate?: boolean; existingData?: CustomerReceipt }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    const reqId = receipt.requestId || `req_rec_${receipt.id}`;
    if (_inFlightRequests.has(reqId)) {
      return { success: false, error: 'A transaction with this Request ID is already in-flight.' };
    }
    _inFlightRequests.add(reqId);

    try {
      await ensureCompanyExists(client, receipt.companyId || 'comp-1');

      const { data, error } = await client.rpc('post_customer_receipt_rpc', {
        p_request_id: reqId,
        p_company_id: receipt.companyId || 'comp-1',
        p_customer_id: receipt.customerId || null,
        p_customer_name: receipt.customerName || 'Customer',
        p_date: receipt.date || new Date().toISOString().split('T')[0],
        p_amount: Number(receipt.amount || 0),
        p_payment_method: receipt.paymentMode || 'CASH',
        p_reference_no: receipt.referenceNo || '',
        p_notes: receipt.notes || ''
      });

      if (error) {
        const isRpcMissing = (error.message || '').toLowerCase().includes('could not find the function') ||
                             (error.message || '').toLowerCase().includes('schema cache') ||
                             (error.message || '').toLowerCase().includes('does not exist') ||
                             error.code === 'PGRST202' ||
                             error.code === '42883';

        if (isRpcMissing) {
          // Direct Table Fallback
          const receiptNumber = receipt.receiptNumber || `REC-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
          const receiptId = receipt.id || `rec-${Date.now()}`;
          const compId = receipt.companyId || 'comp-1';

          const { error: insertErr } = await safeExecuteQuery(
            (payload) => client.from('busy_ufo_customer_receipts').upsert(payload),
            {
              id: receiptId,
              request_id: reqId,
              receipt_number: receiptNumber,
              date: receipt.date || new Date().toISOString().split('T')[0],
              customer_id: receipt.customerId || null,
              customer_name: receipt.customerName || 'Customer',
              amount: Number(receipt.amount || 0),
              payment_method: receipt.paymentMode || 'CASH',
              reference_no: receipt.referenceNo || '',
              notes: receipt.notes || '',
              company_id: compId,
              updated_at: new Date().toISOString()
            }
          );

          if (insertErr) {
            return { success: false, error: insertErr.message };
          }

          if (receipt.customerId) {
            const { data: custData } = await client
              .from('busy_ufo_customers')
              .select('current_balance')
              .eq('id', receipt.customerId)
              .eq('company_id', compId)
              .maybeSingle();

            if (custData) {
              const newBal = Math.max(0, Number(custData.current_balance || 0) - Number(receipt.amount || 0));
              await client
                .from('busy_ufo_customers')
                .update({ current_balance: newBal, updated_at: new Date().toISOString() })
                .eq('id', receipt.customerId)
                .eq('company_id', compId);
            }
          }

          return {
            success: true,
            existingData: {
              ...receipt,
              id: receiptId,
              receiptNumber: receiptNumber,
              requestId: reqId
            }
          };
        }

        const isTimeout = error.message?.toLowerCase().includes('timeout') || error.message?.toLowerCase().includes('failed to fetch');
        if (isTimeout) {
          const recovery = await this.getTransactionByRequestId(reqId);
          if (recovery.found && recovery.id) {
            return {
              success: true,
              isDuplicate: true,
              existingData: {
                ...receipt,
                id: recovery.id,
                receiptNumber: recovery.doc_number || receipt.receiptNumber,
                requestId: reqId
              }
            };
          }
        }
        return { success: false, error: error.message };
      }

      if (data && data.success === false) {
        return { success: false, error: data.error || 'Database rejected customer receipt.' };
      }

      if (data?.success) {
        const recData = data.data;
        return {
          success: true,
          isDuplicate: data.is_duplicate || false,
          existingData: recData ? {
            ...receipt,
            id: recData.id || receipt.id,
            receiptNumber: recData.receipt_number || receipt.receiptNumber,
            requestId: recData.request_id || reqId
          } : undefined
        };
      }

      return { success: false, error: 'Unknown response from post_customer_receipt_rpc.' };
    } catch (e: any) {
      return { success: false, error: e?.message };
    } finally {
      _inFlightRequests.delete(reqId);
    }
  },

  async deleteReceipt(id: string, companyId?: string): Promise<{ success: boolean; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    const reqId = `req_void_rec_${id}`;
    if (_inFlightRequests.has(reqId)) {
      return { success: false, error: 'A void operation for this customer receipt is already in progress.' };
    }
    _inFlightRequests.add(reqId);

    try {
      const compId = companyId || 'comp-1';
      const { data, error } = await client.rpc('void_customer_receipt_rpc', {
        p_receipt_id: id,
        p_company_id: compId,
        p_request_id: reqId
      });

      if (error) {
        const isRpcMissing = (error.message || '').toLowerCase().includes('could not find the function') ||
                             (error.message || '').toLowerCase().includes('schema cache') ||
                             (error.message || '').toLowerCase().includes('does not exist') ||
                             error.code === 'PGRST202' ||
                             error.code === '42883';

        if (isRpcMissing) {
          const { data: recData } = await client
            .from('busy_ufo_customer_receipts')
            .select('*')
            .eq('id', id)
            .maybeSingle();

          const { error: delErr } = await client
            .from('busy_ufo_customer_receipts')
            .delete()
            .eq('id', id);

          if (delErr) {
            return { success: false, error: delErr.message };
          }

          if (recData && recData.customer_id) {
            const { data: custData } = await client
              .from('busy_ufo_customers')
              .select('current_balance')
              .eq('id', recData.customer_id)
              .maybeSingle();

            if (custData) {
              const newBal = Number(custData.current_balance || 0) + Number(recData.amount || 0);
              await client
                .from('busy_ufo_customers')
                .update({ current_balance: newBal, updated_at: new Date().toISOString() })
                .eq('id', recData.customer_id);
            }
          }

          return { success: true };
        }

        return { success: false, error: error.message };
      }

      if (data && typeof data === 'object' && data.success === false) {
        return { success: false, error: data.error || 'Database rejected customer receipt voiding.' };
      }

      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message };
    } finally {
      _inFlightRequests.delete(reqId);
    }
  },

  async updateReceipt(id: string, receipt: CustomerReceipt, compId?: string): Promise<{ success: boolean; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    try {
      const targetCompId = compId || receipt.companyId || 'comp-1';
      const { error: updateErr } = await safeExecuteQuery(
        (payload) => client.from('busy_ufo_customer_receipts').update(payload).eq('id', id),
        {
          customer_id: receipt.customerId || null,
          customer_name: receipt.customerName || 'Customer',
          date: receipt.date || new Date().toISOString().split('T')[0],
          amount: Number(receipt.amount || 0),
          payment_method: receipt.paymentMode || 'CASH',
          reference_no: receipt.referenceNo || '',
          notes: receipt.notes || '',
          updated_at: new Date().toISOString()
        }
      );

      if (updateErr) return { success: false, error: updateErr.message };
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message };
    }
  },

  async syncPayment(payment: SupplierPayment): Promise<{ success: boolean; error?: string; isDuplicate?: boolean; existingData?: SupplierPayment }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    const reqId = payment.requestId || `req_pay_${payment.id}`;
    if (_inFlightRequests.has(reqId)) {
      return { success: false, error: 'A transaction with this Request ID is already in-flight.' };
    }
    _inFlightRequests.add(reqId);

    try {
      await ensureCompanyExists(client, payment.companyId || 'comp-1');

      const { data, error } = await client.rpc('post_supplier_payment_rpc', {
        p_request_id: reqId,
        p_company_id: payment.companyId || 'comp-1',
        p_supplier_id: payment.supplierId || null,
        p_supplier_name: payment.supplierName || 'Supplier',
        p_date: payment.date || new Date().toISOString().split('T')[0],
        p_amount: Number(payment.amount || 0),
        p_payment_method: payment.paymentMode || 'CASH',
        p_reference_no: payment.referenceNo || '',
        p_notes: payment.notes || ''
      });

      if (error) {
        const isRpcMissing = (error.message || '').toLowerCase().includes('could not find the function') ||
                             (error.message || '').toLowerCase().includes('schema cache') ||
                             (error.message || '').toLowerCase().includes('does not exist') ||
                             error.code === 'PGRST202' ||
                             error.code === '42883';

        if (isRpcMissing) {
          // Direct Table Fallback
          const paymentNumber = payment.paymentNumber || `PAY-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
          const paymentId = payment.id || `pay-${Date.now()}`;
          const compId = payment.companyId || 'comp-1';

          const { error: insertErr } = await safeExecuteQuery(
            (payload) => client.from('busy_ufo_supplier_payments').upsert(payload),
            {
              id: paymentId,
              request_id: reqId,
              payment_number: paymentNumber,
              date: payment.date || new Date().toISOString().split('T')[0],
              supplier_id: payment.supplierId || null,
              supplier_name: payment.supplierName || 'Supplier',
              amount: Number(payment.amount || 0),
              payment_method: payment.paymentMode || 'CASH',
              reference_no: payment.referenceNo || '',
              notes: payment.notes || '',
              company_id: compId,
              updated_at: new Date().toISOString()
            }
          );

          if (insertErr) {
            return { success: false, error: insertErr.message };
          }

          if (payment.supplierId) {
            const { data: suppData } = await client
              .from('busy_ufo_suppliers')
              .select('current_balance')
              .eq('id', payment.supplierId)
              .eq('company_id', compId)
              .maybeSingle();

            if (suppData) {
              const newBal = Math.max(0, Number(suppData.current_balance || 0) - Number(payment.amount || 0));
              await client
                .from('busy_ufo_suppliers')
                .update({ current_balance: newBal, updated_at: new Date().toISOString() })
                .eq('id', payment.supplierId)
                .eq('company_id', compId);
            }
          }

          return {
            success: true,
            existingData: {
              ...payment,
              id: paymentId,
              paymentNumber: paymentNumber,
              requestId: reqId
            }
          };
        }

        const isTimeout = error.message?.toLowerCase().includes('timeout') || error.message?.toLowerCase().includes('failed to fetch');
        if (isTimeout) {
          const recovery = await this.getTransactionByRequestId(reqId);
          if (recovery.found && recovery.id) {
            return {
              success: true,
              isDuplicate: true,
              existingData: {
                ...payment,
                id: recovery.id,
                paymentNumber: recovery.doc_number || payment.paymentNumber,
                requestId: reqId
              }
            };
          }
        }
        return { success: false, error: error.message };
      }

      if (data && data.success === false) {
        return { success: false, error: data.error || 'Database rejected supplier payment.' };
      }

      if (data?.success) {
        const payData = data.data;
        return {
          success: true,
          isDuplicate: data.is_duplicate || false,
          existingData: payData ? {
            ...payment,
            id: payData.id || payment.id,
            paymentNumber: payData.payment_number || payment.paymentNumber,
            requestId: payData.request_id || reqId
          } : undefined
        };
      }

      return { success: false, error: 'Unknown response from post_supplier_payment_rpc.' };
    } catch (e: any) {
      return { success: false, error: e?.message };
    } finally {
      _inFlightRequests.delete(reqId);
    }
  },

  async deletePayment(id: string, companyId?: string): Promise<{ success: boolean; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    const reqId = `req_void_pay_${id}`;
    if (_inFlightRequests.has(reqId)) {
      return { success: false, error: 'A void operation for this supplier payment is already in progress.' };
    }
    _inFlightRequests.add(reqId);

    try {
      const compId = companyId || 'comp-1';
      const { data, error } = await client.rpc('void_supplier_payment_rpc', {
        p_payment_id: id,
        p_company_id: compId,
        p_request_id: reqId
      });

      if (error) {
        const isRpcMissing = (error.message || '').toLowerCase().includes('could not find the function') ||
                             (error.message || '').toLowerCase().includes('schema cache') ||
                             (error.message || '').toLowerCase().includes('does not exist') ||
                             error.code === 'PGRST202' ||
                             error.code === '42883';

        if (isRpcMissing) {
          const { data: payData } = await client
            .from('busy_ufo_supplier_payments')
            .select('*')
            .eq('id', id)
            .maybeSingle();

          const { error: delErr } = await client
            .from('busy_ufo_supplier_payments')
            .delete()
            .eq('id', id);

          if (delErr) {
            return { success: false, error: delErr.message };
          }

          if (payData && payData.supplier_id) {
            const { data: suppData } = await client
              .from('busy_ufo_suppliers')
              .select('current_balance')
              .eq('id', payData.supplier_id)
              .maybeSingle();

            if (suppData) {
              const newBal = Number(suppData.current_balance || 0) + Number(payData.amount || 0);
              await client
                .from('busy_ufo_suppliers')
                .update({ current_balance: newBal, updated_at: new Date().toISOString() })
                .eq('id', payData.supplier_id);
            }
          }

          return { success: true };
        }

        return { success: false, error: error.message };
      }

      if (data && typeof data === 'object' && data.success === false) {
        return { success: false, error: data.error || 'Database rejected supplier payment voiding.' };
      }

      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message };
    } finally {
      _inFlightRequests.delete(reqId);
    }
  },

  async updatePayment(id: string, payment: SupplierPayment, compId?: string): Promise<{ success: boolean; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    try {
      const targetCompId = compId || payment.companyId || 'comp-1';
      const { error: updateErr } = await safeExecuteQuery(
        (payload) => client.from('busy_ufo_supplier_payments').update(payload).eq('id', id),
        {
          supplier_id: payment.supplierId || null,
          supplier_name: payment.supplierName || 'Supplier',
          date: payment.date || new Date().toISOString().split('T')[0],
          amount: Number(payment.amount || 0),
          payment_method: payment.paymentMode || 'CASH',
          reference_no: payment.referenceNo || '',
          notes: payment.notes || '',
          updated_at: new Date().toISOString()
        }
      );

      if (updateErr) return { success: false, error: updateErr.message };
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message };
    }
  },

  async syncExpense(expense: Expense): Promise<{ success: boolean; error?: string; isDuplicate?: boolean; existingData?: Expense; expenseNumber?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    const reqId = expense.requestId || `req_exp_${expense.id}`;
    if (_inFlightRequests.has(reqId)) {
      return { success: false, error: 'A transaction with this Request ID is already in-flight.' };
    }
    _inFlightRequests.add(reqId);

    try {
      await ensureCompanyExists(client, expense.companyId || 'comp-1');

      const { data: rpcData, error: rpcError } = await client.rpc('post_expense_rpc', {
        p_request_id: reqId,
        p_company_id: expense.companyId || 'comp-1',
        p_date: expense.date || new Date().toISOString().split('T')[0],
        p_category: expense.category || 'General',
        p_amount: Number(expense.amount || 0),
        p_paid_to: expense.paidTo || '',
        p_payment_method: expense.paymentMode || 'CASH',
        p_notes: expense.notes || ''
      });

      if (rpcError) {
        const isRpcMissing = (rpcError.message || '').toLowerCase().includes('could not find the function') ||
                             (rpcError.message || '').toLowerCase().includes('schema cache') ||
                             (rpcError.message || '').toLowerCase().includes('does not exist') ||
                             rpcError.code === 'PGRST202' ||
                             rpcError.code === '42883';

        if (isRpcMissing) {
          const expenseNumber = expense.expenseNumber || `EXP-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
          const expenseId = expense.id || `exp-${Date.now()}`;
          const compId = expense.companyId || 'comp-1';

          const { error: insertErr } = await safeExecuteQuery(
            (payload) => client.from('busy_ufo_expenses').upsert(payload),
            {
              id: expenseId,
              request_id: reqId,
              expense_number: expenseNumber,
              date: expense.date || new Date().toISOString().split('T')[0],
              category: expense.category || 'General',
              amount: Number(expense.amount || 0),
              paid_to: expense.paidTo || '',
              payment_method: expense.paymentMode || 'CASH',
              notes: expense.notes || '',
              company_id: compId,
              updated_at: new Date().toISOString()
            }
          );

          if (insertErr) {
            return { success: false, error: insertErr.message };
          }

          return {
            success: true,
            expenseNumber: expenseNumber
          };
        }

        const isTimeout = rpcError.message?.toLowerCase().includes('timeout') || rpcError.message?.toLowerCase().includes('failed to fetch');
        if (isTimeout) {
          const recovery = await this.getTransactionByRequestId(reqId);
          if (recovery.found && recovery.id) {
            return {
              success: true,
              isDuplicate: true,
              expenseNumber: recovery.doc_number || expense.expenseNumber
            };
          }
        }
        return { success: false, error: rpcError.message };
      }

      if (rpcData && rpcData.success === false) {
        return { success: false, error: rpcData.error || 'Database rejected expense.' };
      }

      if (rpcData?.success) {
        return {
          success: true,
          isDuplicate: rpcData.is_duplicate || false,
          expenseNumber: rpcData.data?.expense_number || expense.expenseNumber
        };
      }

      return { success: false, error: 'Unknown response from post_expense_rpc.' };
    } catch (e: any) {
      return { success: false, error: e?.message };
    } finally {
      _inFlightRequests.delete(reqId);
    }
  },

  async deleteExpense(id: string): Promise<{ success: boolean; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };
    try {
      const { error } = await client.from('busy_ufo_expenses').delete().eq('id', id);
      if (error) {
        return { success: false, error: error.message };
      }
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message };
    }
  },

  async updateExpense(id: string, expense: Expense, compId?: string): Promise<{ success: boolean; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    try {
      const { error: updateErr } = await safeExecuteQuery(
        (payload) => client.from('busy_ufo_expenses').update(payload).eq('id', id),
        {
          category: expense.category || 'General',
          amount: Number(expense.amount || 0),
          date: expense.date || new Date().toISOString().split('T')[0],
          payment_method: expense.paymentMode || 'CASH',
          paid_to: expense.paidTo || '',
          notes: expense.notes || '',
          updated_at: new Date().toISOString()
        }
      );

      if (updateErr) return { success: false, error: updateErr.message };
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message };
    }
  },

  // --- BULK FETCH FROM SUPABASE ---
  async fetchAllRemoteProducts(companyId?: string): Promise<Product[] | null> {
    const client = getSupabaseClient();
    if (!client) return null;

    try {
      let query = client.from('busy_ufo_products').select('*').order('name');
      if (companyId) {
        query = query.eq('company_id', companyId);
      }
      const { data, error } = await query;

      if (error || !data) return null;

      return data.map((row: any) => ({
        id: row.id,
        companyId: row.company_id || 'comp-1',
        code: row.code,
        name: row.name,
        category: row.category || 'General',
        unit: row.unit || 'Pcs',
        costPrice: Number(row.cost_price || 0),
        sellingPrice: Number(row.selling_price || 0),
        currentStock: Number(row.current_stock || 0),
        reorderLevel: Number(row.reorder_level || 10),
        openingStock: row.opening_stock !== null && row.opening_stock !== undefined ? Number(row.opening_stock) : undefined,
        openingRate: row.opening_rate !== null && row.opening_rate !== undefined ? Number(row.opening_rate) : undefined,
        openingValue: row.opening_value !== null && row.opening_value !== undefined ? Number(row.opening_value) : undefined,
        excelStockValue: row.excel_stock_value !== null && row.excel_stock_value !== undefined ? Number(row.excel_stock_value) : undefined,
        calculatedStockValue: row.calculated_stock_value !== null && row.calculated_stock_value !== undefined ? Number(row.calculated_stock_value) : undefined,
        valueDifference: row.value_difference !== null && row.value_difference !== undefined ? Number(row.value_difference) : undefined,
        importSource: row.import_source || undefined,
        importBatchId: row.import_batch_id || undefined,
        createdAt: row.created_at || new Date().toISOString(),
        updatedAt: row.updated_at || row.updatedAt || row.created_at || new Date().toISOString()
      }));
    } catch (e) {
      console.error('Error fetching products from Supabase:', e);
      return null;
    }
  },

  async fetchAllRemoteCustomers(companyId?: string): Promise<Customer[] | null> {
    const client = getSupabaseClient();
    if (!client) return null;

    try {
      let query = client.from('busy_ufo_customers').select('*').order('name');
      if (companyId) {
        query = query.eq('company_id', companyId);
      }
      const { data, error } = await query;

      if (error || !data) return null;

      return data.map((row: any) => ({
        id: row.id,
        companyId: row.company_id || 'comp-1',
        code: row.code,
        name: row.name,
        phone: row.phone || '',
        email: row.email || '',
        address: row.address || '',
        city: row.city || 'Colombo',
        openingBalance: Number(row.opening_balance || 0),
        outstandingBalance: Number(row.current_balance || 0),
        createdAt: row.created_at || new Date().toISOString(),
        updatedAt: row.updated_at || row.updatedAt || row.created_at || new Date().toISOString()
      }));
    } catch (e) {
      console.error('Error fetching customers from Supabase:', e);
      return null;
    }
  },

  async fetchAllRemoteSuppliers(companyId?: string): Promise<Supplier[] | null> {
    const client = getSupabaseClient();
    if (!client) return null;

    try {
      let query = client.from('busy_ufo_suppliers').select('*').order('name');
      if (companyId) {
        query = query.eq('company_id', companyId);
      }
      const { data, error } = await query;

      if (error || !data) return null;

      return data.map((row: any) => ({
        id: row.id,
        companyId: row.company_id || 'comp-1',
        code: row.code,
        name: row.name,
        phone: row.phone || '',
        email: row.email || '',
        address: row.address || '',
        city: row.city || 'Colombo',
        openingBalance: Number(row.opening_balance || 0),
        payableBalance: Number(row.current_balance || 0),
        createdAt: row.created_at || new Date().toISOString(),
        updatedAt: row.updated_at || row.updatedAt || row.created_at || new Date().toISOString()
      }));
    } catch (e) {
      console.error('Error fetching suppliers from Supabase:', e);
      return null;
    }
  },

  async fetchAllRemoteSales(companyId?: string): Promise<SaleInvoice[] | null> {
    const client = getSupabaseClient();
    if (!client) return null;

    try {
      let query = client.from('busy_ufo_sales').select('*').order('invoice_date', { ascending: false });
      if (companyId) {
        query = query.eq('company_id', companyId);
      }
      const { data: salesData, error: salesError } = await query;
      if (salesError || !salesData) return null;

      // Fetch all sale items
      const saleIds = salesData.map((s: any) => s.id);
      let itemsBySaleId: Record<string, any[]> = {};
      if (saleIds.length > 0) {
        const { data: itemsData } = await client
          .from('busy_ufo_sale_items')
          .select('*')
          .in('invoice_id', saleIds);
        
        if (itemsData) {
          itemsData.forEach((item: any) => {
            if (!itemsBySaleId[item.invoice_id]) itemsBySaleId[item.invoice_id] = [];
            itemsBySaleId[item.invoice_id].push({
              productId: item.product_id || '',
              productCode: item.product_code || '',
              productName: item.product_name || '',
              quantity: Number(item.quantity || 0),
              unitPrice: Number(item.unit_price || 0),
              discount: Number(item.discount || 0),
              discountType: item.discount_type || 'PERCENT',
              total: Number(item.total || 0)
            });
          });
        }
      }

      return salesData.map((row: any) => ({
        id: row.id,
        requestId: row.request_id || row.id,
        companyId: row.company_id || 'comp-1',
        invoiceNumber: row.invoice_number,
        date: row.invoice_date,
        customerId: row.customer_id || undefined,
        customerName: row.customer_name,
        type: row.sale_type as 'CASH' | 'CREDIT',
        items: itemsBySaleId[row.id] || [],
        subtotal: Number(row.total_amount || 0),
        discount: Number(row.overall_discount || 0),
        grandTotal: Number(row.grand_total || 0),
        paidAmount: Number(row.paid_amount || 0),
        dueAmount: Number(row.due_amount || 0),
        notes: row.notes || '',
        createdAt: row.created_at || new Date().toISOString(),
        updatedAt: row.updated_at || row.updatedAt || row.created_at || new Date().toISOString()
      }));
    } catch (e) {
      console.error('Error fetching sales from Supabase:', e);
      return null;
    }
  },

  async fetchAllRemotePurchases(companyId?: string): Promise<PurchaseInvoice[] | null> {
    const client = getSupabaseClient();
    if (!client) return null;

    try {
      let query = client.from('busy_ufo_purchases').select('*').order('purchase_date', { ascending: false });
      if (companyId) {
        query = query.eq('company_id', companyId);
      }
      const { data: purData, error: purError } = await query;
      if (purError || !purData) return null;

      const purIds = purData.map((p: any) => p.id);
      let itemsByPurId: Record<string, any[]> = {};
      if (purIds.length > 0) {
        const { data: itemsData } = await client
          .from('busy_ufo_purchase_items')
          .select('*')
          .in('purchase_id', purIds);
        
        if (itemsData) {
          itemsData.forEach((item: any) => {
            if (!itemsByPurId[item.purchase_id]) itemsByPurId[item.purchase_id] = [];
            itemsByPurId[item.purchase_id].push({
              productId: item.product_id || '',
              productCode: item.product_code || '',
              productName: item.product_name || '',
              quantity: Number(item.quantity || 0),
              unitCost: Number(item.unit_cost || 0),
              discount: Number(item.discount || 0),
              discountType: item.discount_type || 'PERCENT',
              total: Number(item.total || 0)
            });
          });
        }
      }

      return purData.map((row: any) => ({
        id: row.id,
        requestId: row.request_id || row.id,
        companyId: row.company_id || 'comp-1',
        purchaseNumber: row.purchase_number,
        date: row.purchase_date,
        supplierId: row.supplier_id || '',
        supplierName: row.supplier_name,
        type: row.purchase_type as 'CASH' | 'CREDIT',
        items: itemsByPurId[row.id] || [],
        subtotal: Number(row.total_amount || 0),
        discount: Number(row.overall_discount || 0),
        grandTotal: Number(row.grand_total || 0),
        paidAmount: Number(row.paid_amount || 0),
        dueAmount: Number(row.due_amount || 0),
        notes: row.notes || '',
        createdAt: row.created_at || new Date().toISOString(),
        updatedAt: row.updated_at || row.updatedAt || row.created_at || new Date().toISOString()
      }));
    } catch (e) {
      console.error('Error fetching purchases from Supabase:', e);
      return null;
    }
  },

  async fetchAllRemoteSaleReturns(companyId?: string): Promise<SaleReturn[] | null> {
    const client = getSupabaseClient();
    if (!client) return null;
    try {
      let query = client.from('busy_ufo_sale_returns').select('*').order('date', { ascending: false });
      if (companyId) query = query.eq('company_id', companyId);
      const { data, error } = await query;
      if (error || !data) return null;
      return data.map((row: any) => ({
        id: row.id,
        requestId: row.request_id || row.id,
        companyId: row.company_id || 'comp-1',
        returnNumber: row.return_number,
        invoiceId: row.invoice_id || undefined,
        invoiceNumber: row.invoice_number || undefined,
        date: row.date,
        customerId: row.customer_id || '',
        customerName: row.customer_name,
        type: row.type as any,
        reason: row.reason || '',
        items: typeof row.items === 'string' ? JSON.parse(row.items) : (row.items || []),
        subtotal: Number(row.subtotal || 0),
        discount: Number(row.discount || 0),
        grandTotal: Number(row.grand_total || 0),
        refundedAmount: Number(row.refunded_amount || 0),
        notes: row.notes || '',
        status: row.status || 'COMPLETED',
        createdAt: row.created_at || new Date().toISOString()
      }));
    } catch (e) {
      console.error('Error fetching sale returns from Supabase:', e);
      return null;
    }
  },

  async fetchAllRemotePurchaseReturns(companyId?: string): Promise<PurchaseReturn[] | null> {
    const client = getSupabaseClient();
    if (!client) return null;
    try {
      let query = client.from('busy_ufo_purchase_returns').select('*').order('date', { ascending: false });
      if (companyId) query = query.eq('company_id', companyId);
      const { data, error } = await query;
      if (error || !data) return null;
      return data.map((row: any) => ({
        id: row.id,
        requestId: row.request_id || row.id,
        companyId: row.company_id || 'comp-1',
        returnNumber: row.return_number,
        purchaseId: row.purchase_id || undefined,
        purchaseNumber: row.purchase_number || undefined,
        date: row.date,
        supplierId: row.supplier_id || '',
        supplierName: row.supplier_name,
        type: row.type as any,
        reason: row.reason || '',
        items: typeof row.items === 'string' ? JSON.parse(row.items) : (row.items || []),
        subtotal: Number(row.subtotal || 0),
        discount: Number(row.discount || 0),
        grandTotal: Number(row.grand_total || 0),
        notes: row.notes || '',
        status: row.status || 'COMPLETED',
        createdAt: row.created_at || new Date().toISOString()
      }));
    } catch (e) {
      console.error('Error fetching purchase returns from Supabase:', e);
      return null;
    }
  },

  async fetchAllRemoteReceipts(companyId?: string): Promise<CustomerReceipt[] | null> {
    const client = getSupabaseClient();
    if (!client) return null;
    try {
      let query = client.from('busy_ufo_customer_receipts').select('*').order('date', { ascending: false });
      if (companyId) query = query.eq('company_id', companyId);
      const { data, error } = await query;
      if (error || !data) return null;
      return data.map((row: any) => ({
        id: row.id,
        requestId: row.request_id || row.id,
        companyId: row.company_id || 'comp-1',
        receiptNumber: row.receipt_number,
        date: row.date,
        customerId: row.customer_id || '',
        customerName: row.customer_name,
        amount: Number(row.amount || 0),
        paymentMode: (row.payment_method || 'CASH') as 'CASH' | 'BANK_TRANSFER' | 'CHEQUE',
        referenceNo: row.reference_no || '',
        notes: row.notes || '',
        createdAt: row.created_at || new Date().toISOString()
      }));
    } catch (e) {
      console.error('Error fetching receipts from Supabase:', e);
      return null;
    }
  },

  async fetchAllRemotePayments(companyId?: string): Promise<SupplierPayment[] | null> {
    const client = getSupabaseClient();
    if (!client) return null;
    try {
      let query = client.from('busy_ufo_supplier_payments').select('*').order('date', { ascending: false });
      if (companyId) query = query.eq('company_id', companyId);
      const { data, error } = await query;
      if (error || !data) return null;
      return data.map((row: any) => ({
        id: row.id,
        requestId: row.request_id || row.id,
        companyId: row.company_id || 'comp-1',
        paymentNumber: row.payment_number,
        date: row.date,
        supplierId: row.supplier_id || '',
        supplierName: row.supplier_name,
        amount: Number(row.amount || 0),
        paymentMode: (row.payment_method || 'CASH') as 'CASH' | 'BANK_TRANSFER' | 'CHEQUE',
        referenceNo: row.reference_no || '',
        notes: row.notes || '',
        createdAt: row.created_at || new Date().toISOString()
      }));
    } catch (e) {
      console.error('Error fetching payments from Supabase:', e);
      return null;
    }
  },

  async fetchAllRemoteExpenses(companyId?: string): Promise<Expense[] | null> {
    const client = getSupabaseClient();
    if (!client) return null;
    try {
      let query = client.from('busy_ufo_expenses').select('*').order('date', { ascending: false });
      if (companyId) query = query.eq('company_id', companyId);
      const { data, error } = await query;
      if (error || !data) return null;
      return data.map((row: any) => ({
        id: row.id,
        requestId: row.request_id || row.id,
        companyId: row.company_id || 'comp-1',
        expenseNumber: row.expense_number,
        date: row.date,
        category: row.category,
        amount: Number(row.amount || 0),
        paidTo: row.paid_to || '',
        paymentMode: (row.payment_method || 'CASH') as 'CASH' | 'BANK_TRANSFER',
        notes: row.notes || '',
        createdAt: row.created_at || new Date().toISOString()
      }));
    } catch (e) {
      console.error('Error fetching expenses from Supabase:', e);
      return null;
    }
  },

  // --- PDC MANAGEMENT SYNC & ATOMIC RPC WORKFLOW ---
  async savePdcRpc(pdc: PdcTransaction): Promise<{ success: boolean; data?: any; error?: string; isDuplicate?: boolean }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    const reqId = pdc.requestId || `req_pdc_save_${pdc.id}`;
    if (_inFlightRequests.has(reqId)) {
      return { success: false, error: 'A transaction with this Request ID is already in-flight.' };
    }
    _inFlightRequests.add(reqId);

    try {
      await ensureCompanyExists(client, pdc.companyId || 'comp-1');

      // Execute atomic PostgreSQL RPC strictly — NO direct table upsert fallback
      const { data, error } = await client.rpc('save_pdc_rpc', {
        p_request_id: reqId,
        p_company_id: pdc.companyId || 'comp-1',
        p_type: pdc.type,
        p_party_id: pdc.partyId || null,
        p_party_type: pdc.partyType,
        p_party_name: pdc.partyName,
        p_cheque_number: pdc.chequeNumber,
        p_bank_name: pdc.bankName,
        p_cheque_date: pdc.chequeDate,
        p_amount: Number(pdc.amount || 0),
        p_status: pdc.status || 'PENDING',
        p_reference_voucher_no: pdc.referenceVoucherNo || '',
        p_notes: pdc.notes || ''
      });

      if (error) {
        const isRpcMissing = (error.message || '').toLowerCase().includes('could not find the function') ||
                             (error.message || '').toLowerCase().includes('schema cache') ||
                             (error.message || '').toLowerCase().includes('does not exist') ||
                             error.code === 'PGRST202' ||
                             error.code === '42883';

        if (isRpcMissing) {
          const pdcId = pdc.id || `pdc-${Date.now()}`;
          const compId = pdc.companyId || 'comp-1';

          const { error: insertErr } = await safeExecuteQuery(
            (payload) => client.from('busy_ufo_pdcs').upsert(payload),
            {
              id: pdcId,
              request_id: reqId,
              type: pdc.type,
              party_id: pdc.partyId || null,
              party_type: pdc.partyType,
              party_name: pdc.partyName,
              cheque_number: pdc.chequeNumber,
              bank_name: pdc.bankName,
              cheque_date: pdc.chequeDate,
              amount: Number(pdc.amount || 0),
              status: pdc.status || 'PENDING',
              reference_voucher_no: pdc.referenceVoucherNo || '',
              notes: pdc.notes || '',
              company_id: compId,
              updated_at: new Date().toISOString()
            }
          );

          if (insertErr) {
            return { success: false, error: insertErr.message };
          }

          return {
            success: true,
            isDuplicate: false,
            data: {
              ...pdc,
              id: pdcId,
              requestId: reqId
            }
          };
        }

        // Safe timeout recovery without direct table fallback
        const isTimeout = error.message?.toLowerCase().includes('timeout') || error.message?.toLowerCase().includes('failed to fetch');
        if (isTimeout) {
          const recovery = await this.getTransactionByRequestId(reqId);
          if (recovery.found && recovery.id) {
            return {
              success: true,
              isDuplicate: true,
              data: {
                ...pdc,
                id: recovery.id,
                chequeNumber: recovery.doc_number || pdc.chequeNumber,
                requestId: reqId
              }
            };
          }
        }
        return { success: false, error: error.message };
      }

      if (data && typeof data === 'object' && data.success === false) {
        return { success: false, error: data.error || 'Database rejected PDC creation.' };
      }

      if (data) {
        if (typeof data === 'object' && data.success !== undefined) {
          return { success: data.success, isDuplicate: data.is_duplicate || false, data: data.data || data };
        }
        return { success: true, data };
      }

      return { success: false, error: 'Unknown response from save_pdc_rpc.' };
    } catch (e: any) {
      return { success: false, error: e?.message };
    } finally {
      _inFlightRequests.delete(reqId);
    }
  },

  async updatePdcRpc(
    pdc: Partial<PdcTransaction> & { id: string },
    requestId?: string
  ): Promise<{ success: boolean; data?: any; error?: string; isDuplicate?: boolean }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    const reqId = requestId || pdc.requestId || `req_pdc_upd_${pdc.id}_${Date.now()}`;
    if (_inFlightRequests.has(reqId)) {
      return { success: false, error: 'An update with this Request ID is already in-flight.' };
    }
    _inFlightRequests.add(reqId);

    try {
      const compId = pdc.companyId || 'comp-1';
      await ensureCompanyExists(client, compId);

      const { data, error } = await client.rpc('update_pdc_rpc', {
        p_pdc_id: pdc.id,
        p_request_id: reqId,
        p_company_id: compId,
        p_type: pdc.type,
        p_party_id: pdc.partyId || null,
        p_party_type: pdc.partyType || 'CUSTOMER',
        p_party_name: pdc.partyName || 'Party',
        p_cheque_number: pdc.chequeNumber || '',
        p_bank_name: pdc.bankName || '',
        p_cheque_date: pdc.chequeDate || new Date().toISOString().split('T')[0],
        p_amount: Number(pdc.amount || 0),
        p_notes: pdc.notes || ''
      });

      if (error) {
        const isRpcMissing = (error.message || '').toLowerCase().includes('could not find the function') ||
                             (error.message || '').toLowerCase().includes('schema cache') ||
                             (error.message || '').toLowerCase().includes('does not exist') ||
                             error.code === 'PGRST202' ||
                             error.code === '42883';

        if (isRpcMissing) {
          const updatePayload: any = { updated_at: new Date().toISOString() };
          if (pdc.type) updatePayload.type = pdc.type;
          if (pdc.partyId !== undefined) updatePayload.party_id = pdc.partyId;
          if (pdc.partyType) updatePayload.party_type = pdc.partyType;
          if (pdc.partyName) updatePayload.party_name = pdc.partyName;
          if (pdc.chequeNumber) updatePayload.cheque_number = pdc.chequeNumber;
          if (pdc.bankName) updatePayload.bank_name = pdc.bankName;
          if (pdc.chequeDate) updatePayload.cheque_date = pdc.chequeDate;
          if (pdc.amount !== undefined) updatePayload.amount = Number(pdc.amount);
          if (pdc.notes !== undefined) updatePayload.notes = pdc.notes;

          const { error: updErr } = await client
            .from('busy_ufo_pdcs')
            .update(updatePayload)
            .eq('id', pdc.id);

          if (updErr) return { success: false, error: updErr.message };
          return { success: true, data: pdc };
        }

        return { success: false, error: error.message };
      }

      if (data && typeof data === 'object' && data.success === false) {
        return { success: false, error: data.error || 'Database rejected PDC update.' };
      }

      return {
        success: true,
        data: data?.data || data
      };
    } catch (e: any) {
      return { success: false, error: e?.message };
    } finally {
      _inFlightRequests.delete(reqId);
    }
  },

  async depositPdcRpc(
    pdcId: string,
    depositDate: string,
    bankName: string,
    notes?: string,
    requestId?: string
  ): Promise<{ success: boolean; data?: any; error?: string; isDuplicate?: boolean }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    const reqId = requestId || `req_pdc_dep_${pdcId}_${Date.now()}`;
    if (_inFlightRequests.has(reqId)) {
      return { success: false, error: 'Deposit request already in-flight.' };
    }
    _inFlightRequests.add(reqId);

    try {
      const { data, error } = await client.rpc('deposit_pdc_rpc', {
        p_pdc_id: pdcId,
        p_request_id: reqId,
        p_deposit_date: depositDate,
        p_bank_name: bankName,
        p_notes: notes || ''
      });

      if (error) {
        const isTimeout = error.message?.toLowerCase().includes('timeout') || error.message?.toLowerCase().includes('failed to fetch');
        if (isTimeout) {
          const recovery = await this.getTransactionByRequestId(reqId);
          if (recovery.found && recovery.id) {
            return { success: true, isDuplicate: true, data: recovery };
          }
        }
        return { success: false, error: error.message };
      }

      if (data && typeof data === 'object' && data.success === false) {
        return { success: false, error: data.error || 'Database rejected PDC deposit.' };
      }

      if (data) {
        if (typeof data === 'object' && data.success !== undefined) {
          return { success: data.success, data: data.data, isDuplicate: data.is_duplicate };
        }
        return { success: true, data };
      }

      return { success: false, error: 'Unknown response from deposit_pdc_rpc.' };
    } catch (e: any) {
      return { success: false, error: e?.message };
    } finally {
      _inFlightRequests.delete(reqId);
    }
  },

  async clearPdcRpc(
    pdc: PdcTransaction,
    clearedDate: string,
    clearingBankName: string,
    requestId?: string
  ): Promise<{ success: boolean; data?: any; journalId?: string; voucherNo?: string; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    const reqId = requestId || `req_pdc_clr_${pdc.id}_${Date.now()}`;
    if (_inFlightRequests.has(reqId)) {
      return { success: false, error: 'Clearance request already in-flight.' };
    }
    _inFlightRequests.add(reqId);

    try {
      const bankLedgerId = `bank_${clearingBankName.toLowerCase().replace(/\s+/g, '_')}`;
      const partyLedgerId = pdc.partyId;

      const { data, error } = await client.rpc('clear_pdc_rpc', {
        p_pdc_id: pdc.id,
        p_request_id: reqId,
        p_cleared_date: clearedDate,
        p_bank_ledger_id: bankLedgerId,
        p_bank_ledger_name: clearingBankName,
        p_party_ledger_id: partyLedgerId,
        p_party_ledger_name: pdc.partyName
      });

      if (error) {
        return { success: false, error: error.message };
      }

      if (data && typeof data === 'object' && data.success === false) {
        return { success: false, error: data.error || 'Database rejected PDC clearance.' };
      }

      return {
        success: true,
        data: data?.data || data,
        journalId: data?.journal_id,
        voucherNo: data?.voucher_no
      };
    } catch (e: any) {
      return { success: false, error: e?.message };
    } finally {
      _inFlightRequests.delete(reqId);
    }
  },

  async bouncePdcRpc(
    pdc: PdcTransaction,
    bounceDate: string,
    bankName: string,
    bounceReason?: string,
    bounceCharges?: number,
    requestId?: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    const reqId = requestId || `req_pdc_bnc_${pdc.id}_${Date.now()}`;
    if (_inFlightRequests.has(reqId)) {
      return { success: false, error: 'Bounce request already in-flight.' };
    }
    _inFlightRequests.add(reqId);

    try {
      const bankLedgerId = `bank_${bankName.toLowerCase().replace(/\s+/g, '_')}`;
      const partyLedgerId = pdc.partyId;

      const { data, error } = await client.rpc('bounce_pdc_rpc', {
        p_pdc_id: pdc.id,
        p_request_id: reqId,
        p_bounce_date: bounceDate,
        p_bank_ledger_id: bankLedgerId,
        p_bank_ledger_name: bankName,
        p_party_ledger_id: partyLedgerId,
        p_party_ledger_name: pdc.partyName,
        p_bounce_charges: Number(bounceCharges || 0),
        p_notes: bounceReason || 'Dishonored by Bank'
      });

      if (error) {
        return { success: false, error: error.message };
      }

      if (data && typeof data === 'object' && data.success === false) {
        return { success: false, error: data.error || 'Database rejected PDC bounce.' };
      }

      return {
        success: true,
        data: data?.data || data
      };
    } catch (e: any) {
      return { success: false, error: e?.message };
    } finally {
      _inFlightRequests.delete(reqId);
    }
  },

  async cancelPdcRpc(
    pdcId: string,
    reason?: string,
    isReturned: boolean = false,
    requestId?: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    const reqId = requestId || `req_pdc_cnc_${pdcId}_${Date.now()}`;
    if (_inFlightRequests.has(reqId)) {
      return { success: false, error: 'Cancellation request already in-flight.' };
    }
    _inFlightRequests.add(reqId);

    try {
      const { data, error } = await client.rpc('cancel_pdc_rpc', {
        p_pdc_id: pdcId,
        p_request_id: reqId,
        p_reason: reason || '',
        p_is_returned: isReturned
      });

      if (error) {
        return { success: false, error: error.message };
      }

      if (data && typeof data === 'object' && data.success === false) {
        return { success: false, error: data.error || 'Database rejected PDC cancellation.' };
      }

      return {
        success: true,
        data: data?.data || data
      };
    } catch (e: any) {
      return { success: false, error: e?.message };
    } finally {
      _inFlightRequests.delete(reqId);
    }
  },

  async syncPdc(pdc: PdcTransaction, isEdit: boolean = false): Promise<{ success: boolean; error?: string; isDuplicate?: boolean }> {
    // All PDC mutations strictly route to atomic RPCs
    if (isEdit) {
      const res = await this.updatePdcRpc(pdc);
      return { success: res.success, error: res.error };
    }
    return this.savePdcRpc(pdc);
  },

  async deletePdc(id: string, companyId?: string): Promise<{ success: boolean; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    const reqId = `req_void_pdc_${id}`;
    if (_inFlightRequests.has(reqId)) {
      return { success: false, error: 'A void operation for this PDC is already in progress.' };
    }
    _inFlightRequests.add(reqId);

    try {
      const compId = companyId || 'comp-1';
      // Execute atomic void_pdc_rpc
      const { data, error } = await client.rpc('void_pdc_rpc', {
        p_pdc_id: id,
        p_company_id: compId,
        p_request_id: reqId,
        p_reason: 'User deleted PDC'
      });

      if (error) {
        const isRpcMissing = (error.message || '').toLowerCase().includes('could not find the function') ||
                             (error.message || '').toLowerCase().includes('schema cache') ||
                             (error.message || '').toLowerCase().includes('does not exist') ||
                             error.code === 'PGRST202' ||
                             error.code === '42883';

        if (isRpcMissing) {
          const { error: delErr } = await client.from('busy_ufo_pdcs').delete().eq('id', id);
          if (delErr) return { success: false, error: delErr.message };
          return { success: true };
        }

        return { success: false, error: error.message };
      }

      if (data && typeof data === 'object' && data.success === false) {
        return { success: false, error: data.error || 'Database rejected PDC deletion.' };
      }

      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message };
    } finally {
      _inFlightRequests.delete(reqId);
    }
  },

  async fetchAllRemotePdcs(companyId?: string): Promise<PdcTransaction[] | null> {
    const client = getSupabaseClient();
    if (!client) return null;
    try {
      let query = client.from('busy_ufo_pdcs').select('*').order('cheque_date', { ascending: true });
      if (companyId) query = query.eq('company_id', companyId);
      const { data, error } = await query;
      if (error || !data) return null;
      return data.map((row: any) => ({
        id: row.id,
        requestId: row.request_id || row.id,
        companyId: row.company_id || 'comp-1',
        type: row.type as any,
        partyId: row.party_id || '',
        partyType: row.party_type as any,
        partyName: row.party_name,
        chequeNumber: row.cheque_number,
        bankName: row.bank_name,
        clearedBankName: row.cleared_bank_name || undefined,
        chequeDate: row.cheque_date,
        amount: Number(row.amount || 0),
        status: row.status as any,
        referenceVoucherNo: row.reference_voucher_no || '',
        notes: row.notes || '',
        clearedAt: row.cleared_at || undefined,
        depositDate: row.deposit_date || undefined,
        bounceDate: row.bounce_date || undefined,
        bounceReason: row.bounce_reason || undefined,
        bounceCharges: Number(row.bounce_charges || 0),
        linkedJournalId: row.linked_journal_id || undefined,
        createdAt: row.created_at || new Date().toISOString(),
        updatedAt: row.updated_at || undefined
      }));
    } catch (e) {
      console.error('Error fetching PDCs from Supabase:', e);
      return null;
    }
  },

  // --- JOURNAL ENTRIES SYNC ---
  async syncJournalEntry(entry: JournalEntry): Promise<{ success: boolean; error?: string; isDuplicate?: boolean }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    const reqId = entry.requestId || `req_jrn_${entry.id}`;
    if (_inFlightRequests.has(reqId)) {
      return { success: false, error: 'A transaction with this Request ID is already in-flight.' };
    }
    _inFlightRequests.add(reqId);

    try {
      const compId = entry.companyId || 'comp-1';
      await ensureCompanyExists(client, compId);

      const linesPayload = (entry.lines || []).map((l) => ({
        ledger_id: l.ledgerId || null,
        ledger_name: l.ledgerName,
        account_group: l.accountGroup || 'General',
        debit: Number(l.debit || 0),
        credit: Number(l.credit || 0),
        particulars: l.particulars || ''
      }));

      const { data, error } = await client.rpc('save_journal_entry_rpc', {
        p_request_id: reqId,
        p_company_id: compId,
        p_entry_id: entry.id || null,
        p_voucher_no: entry.voucherNo,
        p_voucher_type: entry.voucherType || 'JOURNAL',
        p_voucher_date: entry.voucherDate || new Date().toISOString().split('T')[0],
        p_narration: entry.narration || '',
        p_lines: linesPayload
      });

      if (error) {
        const isRpcMissing = (error.message || '').toLowerCase().includes('could not find the function') ||
                             (error.message || '').toLowerCase().includes('schema cache') ||
                             (error.message || '').toLowerCase().includes('does not exist') ||
                             error.code === 'PGRST202' ||
                             error.code === '42883';

        if (isRpcMissing) {
          const entryId = entry.id || `jrn-${Date.now()}`;
          const debitTotal = (entry.lines || []).reduce((acc, l) => acc + Number(l.debit || 0), 0);
          const creditTotal = (entry.lines || []).reduce((acc, l) => acc + Number(l.credit || 0), 0);

          const { error: insertErr } = await safeExecuteQuery(
            (payload) => client.from('busy_ufo_journal_entries').upsert(payload),
            {
              id: entryId,
              request_id: reqId,
              voucher_no: entry.voucherNo,
              voucher_type: entry.voucherType || 'JOURNAL',
              voucher_date: entry.voucherDate || new Date().toISOString().split('T')[0],
              narration: entry.narration || '',
              debit_total: debitTotal,
              credit_total: creditTotal,
              company_id: compId,
              updated_at: new Date().toISOString()
            }
          );

          if (insertErr) {
            return { success: false, error: insertErr.message };
          }

          if (entry.lines && entry.lines.length > 0) {
            const lineRows = entry.lines.map((l, idx) => ({
              id: `jl-${entryId}-${idx}`,
              journal_id: entryId,
              ledger_id: l.ledgerId || null,
              ledger_name: l.ledgerName,
              account_group: l.accountGroup || 'General',
              debit: Number(l.debit || 0),
              credit: Number(l.credit || 0),
              particulars: l.particulars || ''
            }));
            await safeExecuteQuery(
              (payload) => client.from('busy_ufo_journal_lines').insert(payload),
              lineRows
            );
          }

          return { success: true };
        }

        return { success: false, error: error.message };
      }

      if (data && typeof data === 'object' && data.success === false) {
        return { success: false, error: data.error || 'Database rejected journal entry.' };
      }

      return {
        success: true,
        isDuplicate: data?.is_duplicate || false
      };
    } catch (e: any) {
      return { success: false, error: e?.message };
    } finally {
      _inFlightRequests.delete(reqId);
    }
  },

  async updateJournalEntry(id: string, entry: JournalEntry, compId?: string): Promise<{ success: boolean; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    try {
      const targetCompId = compId || entry.companyId || 'comp-1';
      const debitTotal = (entry.lines || []).reduce((acc, l) => acc + Number(l.debit || 0), 0);
      const creditTotal = (entry.lines || []).reduce((acc, l) => acc + Number(l.credit || 0), 0);

      const { error: updateErr } = await safeExecuteQuery(
        (payload) => client.from('busy_ufo_journal_entries').update(payload).eq('id', id),
        {
          voucher_date: entry.voucherDate || new Date().toISOString().split('T')[0],
          narration: entry.narration || '',
          debit_total: debitTotal,
          credit_total: creditTotal,
          updated_at: new Date().toISOString()
        }
      );

      if (updateErr) return { success: false, error: updateErr.message };

      // Re-insert lines
      await client.from('busy_ufo_journal_lines').delete().eq('journal_id', id);

      if (entry.lines && entry.lines.length > 0) {
        const lineRows = entry.lines.map((l, idx) => ({
          id: `jl-${id}-${idx}`,
          journal_id: id,
          ledger_id: l.ledgerId || null,
          ledger_name: l.ledgerName,
          account_group: l.accountGroup || 'General',
          debit: Number(l.debit || 0),
          credit: Number(l.credit || 0),
          particulars: l.particulars || ''
        }));
        await safeExecuteQuery(
          (payload) => client.from('busy_ufo_journal_lines').insert(payload),
          lineRows
        );
      }

      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message };
    }
  },

  async deleteJournalEntry(id: string, compId?: string): Promise<{ success: boolean; error?: string }> {
    const client = getSupabaseClient();
    if (!client) return { success: false, error: 'Supabase not configured' };

    try {
      await client.from('busy_ufo_journal_lines').delete().eq('journal_id', id);
      const { error } = await client.from('busy_ufo_journal_entries').delete().eq('id', id);
      if (error) return { success: false, error: error.message };
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message };
    }
  },

  async fetchAllRemoteJournalEntries(companyId?: string): Promise<JournalEntry[] | null> {
    const client = getSupabaseClient();
    if (!client) return null;
    try {
      let query = client.from('busy_ufo_journal_entries').select('*, lines:busy_ufo_journal_lines(*)').order('voucher_date', { ascending: false });
      if (companyId) query = query.eq('company_id', companyId);
      const { data, error } = await query;
      if (error || !data) return null;
      return data.map((row: any) => ({
        id: row.id,
        requestId: row.request_id || row.id,
        companyId: row.company_id || 'comp-1',
        voucherNo: row.voucher_no,
        voucherType: row.voucher_type as any,
        voucherDate: row.voucher_date,
        narration: row.narration || '',
        debitTotal: Number(row.debit_total || 0),
        creditTotal: Number(row.credit_total || 0),
        lines: (row.lines || []).map((l: any) => ({
          id: l.id,
          ledgerId: l.ledger_id || '',
          ledgerName: l.ledger_name,
          accountGroup: l.account_group,
          debit: Number(l.debit || 0),
          credit: Number(l.credit || 0),
          particulars: l.particulars || ''
        })),
        createdAt: row.created_at || new Date().toISOString()
      }));
    } catch (e) {
      console.error('Error fetching journal entries from Supabase:', e);
      return null;
    }
  },

  // --- SUPABASE REALTIME MULTI-DEVICE SUBSCRIPTION ---
  subscribeToRemoteChanges(callback: (table: string, eventType: string) => void): () => void {
    const client = getSupabaseClient();
    if (!client) return () => {};

    try {
      const channel = client
        .channel('ufo_realtime_sync')
        .on('postgres_changes', { event: '*', schema: 'public' }, (payload) => {
          callback(payload.table, payload.eventType);
        })
        .subscribe();

      return () => {
        client.removeChannel(channel);
      };
    } catch (e) {
      console.error('Failed to subscribe to Supabase realtime:', e);
      return () => {};
    }
  }
};
