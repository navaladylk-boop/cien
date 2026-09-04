import React, { useState, useMemo } from 'react';
import {
  Plus,
  Search,
  User,
  Phone,
  Mail,
  MapPin,
  Edit2,
  Trash2,
  FileText,
  DollarSign,
  X,
  AlertCircle,
  Printer,
  Calendar,
  CheckCircle2,
  Clock,
  ArrowUpRight,
  ArrowDownLeft,
  RefreshCw
} from 'lucide-react';
import { Customer, AppSettings, SaleInvoice, CustomerReceipt, SaleReturn, AuthSession } from '../types';
import { checkPermission } from '../lib/permissions';
import { STANDARD_ACCOUNT_GROUPS } from '../lib/accountGroups';

interface CustomersProps {
  customers: Customer[];
  settings: AppSettings;
  sales: SaleInvoice[];
  receipts: CustomerReceipt[];
  saleReturns?: SaleReturn[];
  onSaveCustomer: (customer: Partial<Customer>) => void;
  onDeleteCustomer: (id: string) => void;
  session?: AuthSession | null;
}

export const Customers: React.FC<CustomersProps> = ({
  customers,
  settings,
  sales,
  receipts,
  saleReturns,
  onSaveCustomer,
  onDeleteCustomer,
  session
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [onlyOutstanding, setOnlyOutstanding] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Partial<Customer> | null>(null);
  const [selectedLedgerCustomer, setSelectedLedgerCustomer] = useState<Customer | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [statementStartDate, setStatementStartDate] = useState<string>('');
  const [statementEndDate, setStatementEndDate] = useState<string>('');

  const canAdd = checkPermission(session?.effectivePermissions, 'customers', 'add');
  const canEdit = checkPermission(session?.effectivePermissions, 'customers', 'edit');
  const canDelete = checkPermission(session?.effectivePermissions, 'customers', 'delete');

  // Customer Statement Ledger Calculation (Multi-Company Isolated & Chronologically Consistent)
  const customerStatementData = useMemo(() => {
    if (!selectedLedgerCustomer) return null;

    const custCompId = selectedLedgerCustomer.companyId || 'comp-1';
    const openingBal = Number(selectedLedgerCustomer.openingBalance || 0);

    // 1. Filter transactions strictly by customerId AND companyId
    const custSales = sales.filter(
      (s) => s.customerId === selectedLedgerCustomer.id && (!selectedLedgerCustomer.companyId || (s.companyId || 'comp-1') === custCompId)
    );
    const custReceipts = receipts.filter(
      (r) => r.customerId === selectedLedgerCustomer.id && (!selectedLedgerCustomer.companyId || (r.companyId || 'comp-1') === custCompId)
    );
    const custReturns = (saleReturns || []).filter(
      (sr) => sr.customerId === selectedLedgerCustomer.id && (!selectedLedgerCustomer.companyId || (sr.companyId || 'comp-1') === custCompId)
    );

    // 2. Build uniform ledger items
    interface RawLedgerItem {
      id: string;
      date: string;
      createdAt: string;
      type: 'SALE' | 'RECEIPT' | 'RETURN';
      typeLabel: string;
      voucherNo: string;
      particulars: string;
      billedAmount: number;
      receivedAmount: number;
      returnAmount: number;
    }

    const rawItems: RawLedgerItem[] = [];

    custSales.forEach((s) => {
      rawItems.push({
        id: s.id,
        date: s.date || '',
        createdAt: s.createdAt || s.date || '',
        type: 'SALE',
        typeLabel: `SALE INVOICE (${s.type || 'CREDIT'})`,
        voucherNo: s.invoiceNumber || 'INV-SALE',
        particulars: s.notes ? `Sale Invoice - ${s.notes}` : `Sale Invoice (${s.items?.length || 0} items)`,
        billedAmount: Number(s.grandTotal || 0),
        receivedAmount: 0,
        returnAmount: 0
      });
    });

    custReceipts.forEach((r) => {
      rawItems.push({
        id: r.id,
        date: r.date || '',
        createdAt: r.createdAt || r.date || '',
        type: 'RECEIPT',
        typeLabel: `RECEIPT (${r.paymentMode || 'CASH'})`,
        voucherNo: r.receiptNumber || 'REC-VCHR',
        particulars: r.notes ? `Customer Receipt - ${r.notes}` : 'Customer Receipt Voucher',
        billedAmount: 0,
        receivedAmount: Number(r.amount || 0),
        returnAmount: 0
      });
    });

    custReturns.forEach((sr) => {
      rawItems.push({
        id: sr.id,
        date: sr.date || '',
        createdAt: sr.createdAt || sr.date || '',
        type: 'RETURN',
        typeLabel: 'SALES RETURN',
        voucherNo: sr.returnNumber || 'SR-RET',
        particulars: sr.reason ? `Credit Note / Return - ${sr.reason}` : 'Sales Return / Credit Note',
        billedAmount: 0,
        receivedAmount: 0,
        returnAmount: Number(sr.grandTotal || 0)
      });
    });

    // 3. Sort chronologically by date ascending, then createdAt ascending
    rawItems.sort((a, b) => {
      const dateCmp = (a.date || '').localeCompare(b.date || '');
      if (dateCmp !== 0) return dateCmp;
      return (a.createdAt || '').localeCompare(b.createdAt || '');
    });

    // 4. Calculate running balances
    let runningBalance = openingBal;
    const allCalculatedEntries = rawItems.map((item) => {
      // Net receivable change: + Billed - Received - Return
      const netChange = item.billedAmount - item.receivedAmount - item.returnAmount;
      runningBalance = Number((runningBalance + netChange).toFixed(2));
      return {
        ...item,
        netChange,
        runningBalance
      };
    });

    // 5. Total aggregations
    const totalBilled = rawItems.reduce((sum, item) => sum + item.billedAmount, 0);
    const totalReceived = rawItems.reduce((sum, item) => sum + item.receivedAmount, 0);
    const totalReturns = rawItems.reduce((sum, item) => sum + item.returnAmount, 0);
    const finalCalculatedBalance = runningBalance;
    const storedBalance = Number(selectedLedgerCustomer.outstandingBalance || 0);

    // 6. Apply optional date filter to the displayed rows
    const displayedEntries = allCalculatedEntries.filter((item) => {
      if (statementStartDate && item.date < statementStartDate) return false;
      if (statementEndDate && item.date > statementEndDate) return false;
      return true;
    });

    return {
      openingBalance: openingBal,
      totalBilled,
      totalReceived,
      totalReturns,
      finalCalculatedBalance,
      storedBalance,
      isReconciled: Math.abs(finalCalculatedBalance - storedBalance) < 0.01,
      variance: Number((storedBalance - finalCalculatedBalance).toFixed(2)),
      entries: displayedEntries,
      totalEntriesCount: allCalculatedEntries.length
    };
  }, [selectedLedgerCustomer, sales, receipts, saleReturns, statementStartDate, statementEndDate]);

  // Form State
  const [formData, setFormData] = useState({
    code: '',
    name: '',
    phone: '',
    email: '',
    address: '',
    city: 'Colombo',
    openingBalance: '0'
  });

  const [formError, setFormError] = useState('');

  const handleOpenAdd = () => {
    setEditingCustomer(null);
    setFormError('');
    const codeCount = customers.length + 1;
    setFormData({
      code: `CUST-${String(codeCount).padStart(3, '0')}`,
      name: '',
      phone: '',
      email: '',
      address: '',
      city: 'Colombo',
      accountGroup: 'Sundry Debtors',
      openingBalance: '0'
    });
    setIsModalOpen(true);
  };

  const handleOpenEdit = (cust: Customer) => {
    setEditingCustomer(cust);
    setFormError('');
    setFormData({
      code: cust.code,
      name: cust.name,
      phone: cust.phone,
      email: cust.email || '',
      address: cust.address || '',
      city: cust.city || 'Colombo',
      accountGroup: cust.accountGroup || 'Sundry Debtors',
      openingBalance: (cust.openingBalance || 0).toString()
    });
    setIsModalOpen(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    if (!formData.name.trim()) {
      setFormError('Customer Name is required.');
      return;
    }

    if (!formData.phone.trim()) {
      setFormError('Phone Number is required.');
      return;
    }

    // Check duplicate customer name or phone
    const duplicate = customers.find(
      (c) =>
        c.id !== editingCustomer?.id &&
        (c.name.trim().toLowerCase() === formData.name.trim().toLowerCase() ||
          c.phone.trim() === formData.phone.trim())
    );

    if (duplicate) {
      if (duplicate.name.trim().toLowerCase() === formData.name.trim().toLowerCase()) {
        setFormError(`A customer named "${formData.name.trim()}" already exists.`);
        return;
      }
      if (duplicate.phone.trim() === formData.phone.trim()) {
        setFormError(`A customer with phone number "${formData.phone.trim()}" already exists.`);
        return;
      }
    }

    onSaveCustomer({
      id: editingCustomer?.id,
      code: formData.code,
      name: formData.name.trim(),
      phone: formData.phone.trim(),
      email: formData.email.trim(),
      address: formData.address.trim(),
      city: formData.city.trim(),
      accountGroup: formData.accountGroup || 'Sundry Debtors',
      openingBalance: Number(formData.openingBalance || 0)
    });

    setIsModalOpen(false);
  };

  // Dynamic accurate ledger balance for every customer
  const customerCalculatedBalances = useMemo(() => {
    const map = new Map<string, number>();
    customers.forEach((c) => {
      const custCompId = c.companyId || 'comp-1';
      const custSales = sales.filter(
        (s) => s.customerId === c.id && (!c.companyId || (s.companyId || 'comp-1') === custCompId)
      );
      const custReceipts = receipts.filter(
        (r) => r.customerId === c.id && (!c.companyId || (r.companyId || 'comp-1') === custCompId)
      );
      const custReturns = (saleReturns || []).filter(
        (sr) => sr.customerId === c.id && (!c.companyId || (sr.companyId || 'comp-1') === custCompId)
      );

      const totalBilled = custSales.reduce((sum, s) => sum + Number(s.grandTotal || 0), 0);
      const totalReceived = custReceipts.reduce((sum, r) => sum + Number(r.amount || 0), 0);
      const totalReturns = custReturns.reduce((sum, sr) => sum + Number(sr.grandTotal || 0), 0);
      const calculatedBal = Number((Number(c.openingBalance || 0) + totalBilled - totalReceived - totalReturns).toFixed(2));
      map.set(c.id, calculatedBal);
    });
    return map;
  }, [customers, sales, receipts, saleReturns]);

  // Filtered customers
  const filteredCustomers = customers.filter((c) => {
    const q = searchTerm.toLowerCase().trim();
    const currentOutstanding = customerCalculatedBalances.get(c.id) ?? c.outstandingBalance;
    if (!q) {
      return onlyOutstanding ? currentOutstanding > 0 : true;
    }
    const terms = q.split(/\s+/).filter(Boolean);
    const searchable = `${c.name || ''} ${c.code || ''} ${c.phone || ''} ${c.city || ''} ${c.address || ''} ${c.email || ''}`.toLowerCase();
    const rawPhone = (c.phone || '').replace(/[^0-9]/g, '');

    const matchesSearch = terms.every((t) => {
      const cleanTerm = t.replace(/[^0-9a-z]/g, '');
      return searchable.includes(t) || (cleanTerm.length > 2 && rawPhone.includes(cleanTerm));
    });

    if (onlyOutstanding) {
      return matchesSearch && currentOutstanding > 0;
    }
    return matchesSearch;
  });

  const totalOutstanding = customers.reduce((sum, c) => sum + (customerCalculatedBalances.get(c.id) ?? c.outstandingBalance), 0);

  return (
    <div className="space-y-6 pb-8">
      {/* Header & Stats Banner */}
      <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Customer Management</h2>
          <p className="text-xs text-slate-500">Add, manage, and track customer outstanding balances</p>
        </div>

        <div className="flex items-center gap-4">
          <div className="bg-amber-50 border border-amber-200 px-4 py-2 rounded-xl text-right">
            <span className="text-[10px] font-bold text-amber-700 uppercase block">Total Outstanding</span>
            <span className="text-lg font-black text-amber-900 font-mono">
              {settings.currencySymbol} {totalOutstanding.toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </span>
          </div>

          {canAdd && (
            <button
              onClick={handleOpenAdd}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-bold px-4 py-2.5 rounded-xl shadow-xs transition-all cursor-pointer text-sm"
            >
              <Plus className="w-4 h-4 text-yellow-400" />
              <span>Add Customer</span>
            </button>
          )}
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
          <input
            type="text"
            placeholder="Search by name, code, phone, city..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 rounded-xl border border-slate-200 text-sm focus:outline-hidden focus:border-blue-500"
          />
        </div>

        <label className="flex items-center gap-2 text-sm font-medium text-slate-700 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={onlyOutstanding}
            onChange={(e) => setOnlyOutstanding(e.target.checked)}
            className="w-4 h-4 text-blue-600 rounded-md border-slate-300 focus:ring-blue-500"
          />
          <span>Show Only Customers With Outstanding Balance</span>
        </label>
      </div>

      {/* Customer Cards Grid */}
      {filteredCustomers.length === 0 ? (
        <div className="bg-white p-12 text-center rounded-2xl border border-slate-200 text-slate-400">
          No customers found matching your criteria.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredCustomers.map((cust) => (
            <div
              key={cust.id}
              className="bg-white rounded-2xl border border-slate-200 shadow-xs p-5 hover:border-blue-300 transition-all flex flex-col justify-between"
            >
              <div>
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="px-2 py-0.5 bg-slate-100 text-slate-600 font-mono text-xs font-bold rounded-md">
                        {cust.code}
                      </span>
                      <span className="px-2 py-0.5 bg-emerald-50 text-emerald-700 text-[10px] font-bold rounded-md border border-emerald-200">
                        {cust.accountGroup || 'Sundry Debtors'}
                      </span>
                    </div>
                    <h3 className="font-bold text-slate-900 text-base mt-1.5">{cust.name}</h3>
                  </div>

                  <div className="text-right">
                    <span className="text-[10px] font-bold text-slate-400 uppercase block">Outstanding</span>
                    <span
                      className={`font-mono font-extrabold text-sm ${
                        (customerCalculatedBalances.get(cust.id) ?? cust.outstandingBalance) > 0 ? 'text-amber-600' : 'text-emerald-600'
                      }`}
                    >
                        {settings.currencySymbol} {((customerCalculatedBalances.get(cust.id) ?? cust.outstandingBalance) || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>

                <div className="space-y-1.5 text-xs text-slate-600 mb-4 border-t border-slate-100 pt-3">
                  <div className="flex items-center gap-2">
                    <Phone className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <span>{cust.phone}</span>
                  </div>
                  {cust.email && (
                    <div className="flex items-center gap-2">
                      <Mail className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <span className="truncate">{cust.email}</span>
                    </div>
                  )}
                  {cust.address && (
                    <div className="flex items-center gap-2">
                      <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <span className="truncate">
                        {cust.address}
                        {cust.city ? `, ${cust.city}` : ''}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* Card Actions */}
              <div className="flex items-center justify-between border-t border-slate-100 pt-3 text-xs">
                <button
                  onClick={() => setSelectedLedgerCustomer(cust)}
                  className="text-blue-600 hover:text-blue-800 font-bold flex items-center gap-1 cursor-pointer"
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>View Statement</span>
                </button>

                <div className="flex items-center gap-2">
                  {canEdit && (
                    <button
                      onClick={() => handleOpenEdit(cust)}
                      className="p-1.5 hover:bg-slate-100 text-slate-600 rounded-lg cursor-pointer"
                      title="Edit Customer"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                  )}
                  {canDelete && (
                    <button
                      onClick={() => setDeleteConfirmId(cust.id)}
                      className="p-1.5 hover:bg-rose-50 text-rose-600 rounded-lg cursor-pointer"
                      title="Delete Customer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add / Edit Customer Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full p-6 animate-in fade-in zoom-in-95">
            <div className="flex items-center justify-between pb-4 border-b border-slate-100">
              <h3 className="font-bold text-lg text-slate-900">
                {editingCustomer ? 'Edit Customer' : 'Add New Customer'}
              </h3>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4 pt-4">
              {formError && (
                <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl font-medium">
                  {formError}
                </div>
              )}
              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                  Customer Code
                </label>
                <input
                  type="text"
                  required
                  value={formData.code}
                  onChange={(e) => setFormData({ ...formData, code: e.target.value })}
                  className="w-full p-2.5 rounded-xl border border-slate-200 text-sm font-mono focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                  Customer / Business Name *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Perera Retail Store"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full p-2.5 rounded-xl border border-slate-200 text-sm focus:border-blue-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                    Phone Number *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="0771234567"
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                    className="w-full p-2.5 rounded-xl border border-slate-200 text-sm focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                    City / Area
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Kandy"
                    value={formData.city}
                    onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                    className="w-full p-2.5 rounded-xl border border-slate-200 text-sm focus:border-blue-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                  Email Address
                </label>
                <input
                  type="email"
                  placeholder="customer@email.com"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="w-full p-2.5 rounded-xl border border-slate-200 text-sm focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                  Account Group (Chart of Accounts)
                </label>
                <select
                  value={formData.accountGroup}
                  onChange={(e) => setFormData({ ...formData, accountGroup: e.target.value })}
                  className="w-full p-2.5 rounded-xl border border-slate-200 text-sm focus:border-blue-500 bg-white"
                >
                  <optgroup label="Assets / Trade Receivables (Default)">
                    {STANDARD_ACCOUNT_GROUPS.filter((g) => g.nature === 'ASSET').map((g) => (
                      <option key={g.no} value={g.name}>
                        {g.no}. {g.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Other Account Groups">
                    {STANDARD_ACCOUNT_GROUPS.filter((g) => g.nature !== 'ASSET').map((g) => (
                      <option key={g.no} value={g.name}>
                        {g.no}. {g.name}
                      </option>
                    ))}
                  </optgroup>
                </select>
                <p className="text-[11px] text-slate-400 mt-1">
                  Default: 25. Sundry Debtors (Trade Customers)
                </p>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                  Street Address
                </label>
                <input
                  type="text"
                  placeholder="Street / Building No."
                  value={formData.address}
                  onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                  className="w-full p-2.5 rounded-xl border border-slate-200 text-sm focus:border-blue-500"
                />
              </div>

              {!editingCustomer && (
                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                    Opening Balance ({settings.currencySymbol})
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={formData.openingBalance}
                    onChange={(e) => setFormData({ ...formData, openingBalance: e.target.value })}
                    className="w-full p-2.5 rounded-xl border border-slate-200 text-sm font-mono focus:border-blue-500"
                  />
                  <p className="text-[11px] text-slate-400 mt-1">
                    Enter positive amount if customer already owes money before starting.
                  </p>
                </div>
              )}

              <div className="flex items-center justify-end gap-3 border-t border-slate-100 pt-4">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-100 rounded-xl"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 text-sm font-bold bg-blue-600 text-white rounded-xl shadow-xs hover:bg-blue-700"
                >
                  Save Customer
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirmId && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-sm w-full p-6 text-center">
            <AlertCircle className="w-12 h-12 text-rose-500 mx-auto mb-3" />
            <h3 className="font-bold text-lg text-slate-900">Delete Customer?</h3>
            <p className="text-xs text-slate-500 mt-1 mb-6">
              Are you sure you want to remove this customer record? This action cannot be undone.
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => setDeleteConfirmId(null)}
                className="px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-100 rounded-xl"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  onDeleteCustomer(deleteConfirmId);
                  setDeleteConfirmId(null);
                }}
                className="px-5 py-2 text-sm font-bold bg-rose-600 text-white rounded-xl hover:bg-rose-700"
              >
                Yes, Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Customer Ledger Statement Modal */}
      {selectedLedgerCustomer && customerStatementData && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 max-w-4xl w-full p-4 sm:p-6 animate-in fade-in zoom-in-95 max-h-[92vh] flex flex-col" id="printable-statement">
            {/* Printed Header with Company Name */}
            <div className="hidden print:block text-center pb-4 mb-4 border-b-2 border-slate-900">
              <div className="inline-flex items-center justify-center gap-1.5 mb-1">
                <span className="text-xl font-black text-blue-600 tracking-tight">Busy</span>
                <span className="text-xl font-black text-yellow-500 bg-yellow-100 px-1.5 py-0.2 rounded-md border border-yellow-300 text-xs">
                  UFO
                </span>
              </div>
              <h1 className="text-xl font-black text-slate-900 uppercase tracking-wide">
                {settings.companyName || 'Business Name'}
              </h1>
              <p className="text-xs text-slate-600">{settings.companyAddress}</p>
              <p className="text-xs text-slate-600 font-mono">
                Tel: {settings.companyPhone} {settings.companyEmail ? `| Email: ${settings.companyEmail}` : ''}
                {settings.taxRegistrationNo ? ` | VAT: ${settings.taxRegistrationNo}` : ''}
              </p>
              <div className="mt-2 pt-2 border-t border-slate-300 flex justify-between text-xs font-bold text-slate-800">
                <span>CUSTOMER STATEMENT: {selectedLedgerCustomer.name} ({selectedLedgerCustomer.code})</span>
                <span>DATE: {new Date().toLocaleDateString()}</span>
              </div>
            </div>

            {/* Modal Screen Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-slate-100 gap-3 print:hidden">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-bold text-lg text-slate-900">
                    {selectedLedgerCustomer.name}
                  </h3>
                  <span className="px-2 py-0.5 bg-blue-100 text-blue-800 text-xs font-mono font-bold rounded-md">
                    {selectedLedgerCustomer.code}
                  </span>
                  {selectedLedgerCustomer.accountGroup && (
                    <span className="px-2 py-0.5 bg-slate-100 text-slate-700 text-xs font-semibold rounded-md">
                      {selectedLedgerCustomer.accountGroup}
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  Phone: {selectedLedgerCustomer.phone} {selectedLedgerCustomer.address ? `• ${selectedLedgerCustomer.address}` : ''} {selectedLedgerCustomer.city ? `(${selectedLedgerCustomer.city})` : ''}
                </p>
              </div>

              <div className="flex items-center gap-2 self-end sm:self-auto">
                <button
                  onClick={() => window.print()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white cursor-pointer font-bold text-xs shadow-xs"
                  title="Print Statement"
                >
                  <Printer className="w-4 h-4 text-yellow-300" />
                  <span>Print</span>
                </button>
                <button
                  onClick={() => {
                    setSelectedLedgerCustomer(null);
                    setStatementStartDate('');
                    setStatementEndDate('');
                  }}
                  className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Date Range Filter Toolbar */}
            <div className="py-2.5 px-3 my-2 bg-slate-50 rounded-xl border border-slate-200/80 flex flex-wrap items-center justify-between gap-2 text-xs print:hidden">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-slate-600 flex items-center gap-1">
                  <Calendar className="w-3.5 h-3.5 text-slate-500" />
                  Period:
                </span>
                <input
                  type="date"
                  value={statementStartDate}
                  onChange={(e) => setStatementStartDate(e.target.value)}
                  className="px-2 py-1 bg-white border border-slate-300 rounded-lg text-xs text-slate-800 font-medium"
                  placeholder="From"
                />
                <span className="text-slate-400">to</span>
                <input
                  type="date"
                  value={statementEndDate}
                  onChange={(e) => setStatementEndDate(e.target.value)}
                  className="px-2 py-1 bg-white border border-slate-300 rounded-lg text-xs text-slate-800 font-medium"
                  placeholder="To"
                />
                {(statementStartDate || statementEndDate) && (
                  <button
                    onClick={() => {
                      setStatementStartDate('');
                      setStatementEndDate('');
                    }}
                    className="text-xs text-blue-600 hover:text-blue-800 font-semibold underline cursor-pointer ml-1"
                  >
                    Reset Filter
                  </button>
                )}
              </div>

              <div className="flex items-center gap-1.5 flex-wrap">
                {customerStatementData.isReconciled ? (
                  <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 bg-emerald-100/80 px-2.5 py-0.5 rounded-md">
                    <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                    Ledger Reconciled
                  </span>
                ) : (
                  <>
                    <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-800 bg-amber-100/80 px-2.5 py-0.5 rounded-md" title={`Stored Balance: ${customerStatementData.storedBalance.toFixed(2)} | Calculated: ${customerStatementData.finalCalculatedBalance.toFixed(2)}`}>
                      <AlertCircle className="w-3 h-3 text-amber-600" />
                      Variance: {settings.currencySymbol} {Math.abs(customerStatementData.variance).toFixed(2)}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        onSaveCustomer({
                          ...selectedLedgerCustomer,
                          outstandingBalance: customerStatementData.finalCalculatedBalance
                        });
                        setSelectedLedgerCustomer({
                          ...selectedLedgerCustomer,
                          outstandingBalance: customerStatementData.finalCalculatedBalance
                        });
                      }}
                      className="inline-flex items-center gap-1 text-[11px] font-bold text-white bg-amber-600 hover:bg-amber-700 px-2.5 py-0.5 rounded-md shadow-xs transition-colors cursor-pointer"
                      title="Update stored database balance to match exact ledger transactions"
                    >
                      <RefreshCw className="w-3 h-3" />
                      <span>Sync Balance ({settings.currencySymbol} {customerStatementData.finalCalculatedBalance.toFixed(2)})</span>
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Financial Summary KPIs */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 mb-2">
              <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-200">
                <span className="text-[10px] text-slate-500 font-bold uppercase block">
                  Opening Balance
                </span>
                <span className="text-sm font-mono font-bold text-slate-800">
                  {settings.currencySymbol} {customerStatementData.openingBalance.toFixed(2)}
                </span>
              </div>
              <div className="bg-blue-50/60 p-2.5 rounded-xl border border-blue-100">
                <span className="text-[10px] text-blue-700 font-bold uppercase block">
                  (+) Total Billed
                </span>
                <span className="text-sm font-mono font-bold text-blue-900">
                  {settings.currencySymbol} {customerStatementData.totalBilled.toFixed(2)}
                </span>
              </div>
              <div className="bg-emerald-50/60 p-2.5 rounded-xl border border-emerald-100">
                <span className="text-[10px] text-emerald-700 font-bold uppercase block">
                  (-) Total Received
                </span>
                <span className="text-sm font-mono font-bold text-emerald-900">
                  {settings.currencySymbol} {customerStatementData.totalReceived.toFixed(2)}
                </span>
              </div>
              <div className="bg-purple-50/60 p-2.5 rounded-xl border border-purple-100">
                <span className="text-[10px] text-purple-700 font-bold uppercase block">
                  (-) Credit Returns
                </span>
                <span className="text-sm font-mono font-bold text-purple-900">
                  {settings.currencySymbol} {customerStatementData.totalReturns.toFixed(2)}
                </span>
              </div>
              <div className="col-span-2 sm:col-span-1 bg-amber-50 p-2.5 rounded-xl border border-amber-200">
                <span className="text-[10px] text-amber-700 font-bold uppercase block">
                  (=) Net Receivable
                </span>
                <span className="text-sm font-mono font-black text-amber-900">
                  {settings.currencySymbol} {customerStatementData.finalCalculatedBalance.toFixed(2)}
                </span>
              </div>
            </div>

            {/* Chronological Statement Table */}
            <div className="flex-1 overflow-y-auto border border-slate-200 rounded-xl">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-100/80 text-slate-600 uppercase font-bold sticky top-0 border-b border-slate-200 z-10 text-[11px]">
                  <tr>
                    <th className="p-2.5">Date</th>
                    <th className="p-2.5">Voucher / Ref</th>
                    <th className="p-2.5">Particulars</th>
                    <th className="p-2.5 text-right">Billed (+Dr)</th>
                    <th className="p-2.5 text-right">Received/Ret (-Cr)</th>
                    <th className="p-2.5 text-right">Running Outstanding</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono">
                  {/* Opening Balance Line */}
                  <tr className="bg-slate-50/60 font-semibold">
                    <td className="p-2.5 text-slate-500">-</td>
                    <td className="p-2.5 text-slate-500">OB-000</td>
                    <td className="p-2.5 font-sans text-slate-700">Opening Ledger Balance</td>
                    <td className="p-2.5 text-right text-slate-700">{customerStatementData.openingBalance.toFixed(2)}</td>
                    <td className="p-2.5 text-right text-slate-400">0.00</td>
                    <td className="p-2.5 text-right font-bold text-slate-800">{customerStatementData.openingBalance.toFixed(2)}</td>
                  </tr>

                  {customerStatementData.entries.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="p-6 text-center text-slate-400 font-sans italic">
                        No transactions recorded for this customer within the selected period.
                      </td>
                    </tr>
                  ) : (
                    customerStatementData.entries.map((entry) => (
                      <tr key={entry.id} className="hover:bg-slate-50/80 transition-colors">
                        <td className="p-2.5 text-slate-600 whitespace-nowrap">{entry.date}</td>
                        <td className="p-2.5 font-bold text-blue-700 whitespace-nowrap">{entry.voucherNo}</td>
                        <td className="p-2.5 font-sans text-slate-800">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                              entry.type === 'SALE' ? 'bg-blue-100 text-blue-800' :
                              entry.type === 'RECEIPT' ? 'bg-emerald-100 text-emerald-800' :
                              'bg-purple-100 text-purple-800'
                            }`}>
                              {entry.typeLabel}
                            </span>
                            <span className="text-xs text-slate-600">{entry.particulars}</span>
                          </div>
                        </td>
                        <td className="p-2.5 text-right font-bold text-slate-900">
                          {entry.billedAmount > 0 ? entry.billedAmount.toFixed(2) : '-'}
                        </td>
                        <td className="p-2.5 text-right font-bold text-emerald-700">
                          {entry.receivedAmount > 0 ? entry.receivedAmount.toFixed(2) : entry.returnAmount > 0 ? entry.returnAmount.toFixed(2) : '-'}
                        </td>
                        <td className="p-2.5 text-right font-bold text-slate-900 bg-slate-50/30">
                          {entry.runningBalance.toFixed(2)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
                <tfoot className="bg-slate-50 font-bold border-t-2 border-slate-200 text-[11px] sticky bottom-0">
                  <tr>
                    <td colSpan={3} className="p-2.5 text-slate-700 font-sans uppercase">Total Summary (Period)</td>
                    <td className="p-2.5 text-right font-mono text-slate-900">{customerStatementData.totalBilled.toFixed(2)}</td>
                    <td className="p-2.5 text-right font-mono text-emerald-800">{(customerStatementData.totalReceived + customerStatementData.totalReturns).toFixed(2)}</td>
                    <td className="p-2.5 text-right font-mono text-amber-900">{customerStatementData.finalCalculatedBalance.toFixed(2)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Footer */}
            <div className="pt-3 mt-1 flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-t border-slate-100 print:hidden">
              <span className="text-xs text-slate-500">
                Showing {customerStatementData.entries.length} of {customerStatementData.totalEntriesCount} transactional records
              </span>
              <button
                onClick={() => {
                  setSelectedLedgerCustomer(null);
                  setStatementStartDate('');
                  setStatementEndDate('');
                }}
                className="px-5 py-2 bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs rounded-xl self-end cursor-pointer"
              >
                Close Statement
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
