import React, { useState, useMemo } from 'react';
import {
  Plus,
  Search,
  Truck,
  Phone,
  Mail,
  MapPin,
  Edit2,
  Trash2,
  FileText,
  Building,
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
import { Supplier, AppSettings, PurchaseInvoice, SupplierPayment, PurchaseReturn, AuthSession } from '../types';
import { checkPermission } from '../lib/permissions';
import { STANDARD_ACCOUNT_GROUPS } from '../lib/accountGroups';

interface SuppliersProps {
  suppliers: Supplier[];
  settings: AppSettings;
  purchases: PurchaseInvoice[];
  payments: SupplierPayment[];
  purchaseReturns?: PurchaseReturn[];
  onSaveSupplier: (supplier: Partial<Supplier>) => void;
  onDeleteSupplier: (id: string) => void;
  session?: AuthSession | null;
}

export const Suppliers: React.FC<SuppliersProps> = ({
  suppliers,
  settings,
  purchases,
  payments,
  purchaseReturns,
  onSaveSupplier,
  onDeleteSupplier,
  session
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [onlyPayable, setOnlyPayable] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Partial<Supplier> | null>(null);
  const [selectedLedgerSupplier, setSelectedLedgerSupplier] = useState<Supplier | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [statementStartDate, setStatementStartDate] = useState<string>('');
  const [statementEndDate, setStatementEndDate] = useState<string>('');

  const canAdd = checkPermission(session?.effectivePermissions, 'suppliers', 'add');
  const canEdit = checkPermission(session?.effectivePermissions, 'suppliers', 'edit');
  const canDelete = checkPermission(session?.effectivePermissions, 'suppliers', 'delete');

  // Supplier Statement Ledger Calculation (Multi-Company Isolated & Chronologically Consistent)
  const supplierStatementData = useMemo(() => {
    if (!selectedLedgerSupplier) return null;

    const suppCompId = selectedLedgerSupplier.companyId || 'comp-1';
    const openingBal = Number(selectedLedgerSupplier.openingBalance || 0);

    // 1. Filter transactions strictly by supplierId AND companyId
    const suppPurchases = purchases.filter(
      (p) => p.supplierId === selectedLedgerSupplier.id && (!selectedLedgerSupplier.companyId || (p.companyId || 'comp-1') === suppCompId)
    );
    const suppPayments = payments.filter(
      (pm) => pm.supplierId === selectedLedgerSupplier.id && (!selectedLedgerSupplier.companyId || (pm.companyId || 'comp-1') === suppCompId)
    );
    const suppReturns = (purchaseReturns || []).filter(
      (pr) => pr.supplierId === selectedLedgerSupplier.id && (!selectedLedgerSupplier.companyId || (pr.companyId || 'comp-1') === suppCompId)
    );

    // 2. Build uniform ledger items
    interface RawLedgerItem {
      id: string;
      date: string;
      createdAt: string;
      type: 'PURCHASE' | 'PAYMENT' | 'RETURN';
      typeLabel: string;
      voucherNo: string;
      particulars: string;
      billedAmount: number;
      paidAmount: number;
      returnAmount: number;
      paymentMode?: string;
    }

    const rawItems: RawLedgerItem[] = [];

    suppPurchases.forEach((p) => {
      rawItems.push({
        id: p.id,
        date: p.date || (p as any).purchaseDate || '',
        createdAt: p.createdAt || p.date || '',
        type: 'PURCHASE',
        typeLabel: `PURCHASE (${p.type || 'CREDIT'})`,
        voucherNo: p.purchaseNumber || 'PUR-BILL',
        particulars: p.notes ? `Purchase Bill - ${p.notes}` : `Purchase Bill (${p.items?.length || 0} items)`,
        billedAmount: Number(p.grandTotal || 0),
        paidAmount: 0,
        returnAmount: 0
      });
    });

    suppPayments.forEach((pm) => {
      rawItems.push({
        id: pm.id,
        date: pm.date || (pm as any).paymentDate || '',
        createdAt: pm.createdAt || pm.date || '',
        type: 'PAYMENT',
        typeLabel: `PAYMENT (${pm.paymentMode || (pm as any).paymentMethod || 'CASH'})`,
        voucherNo: pm.paymentNumber || 'PAY-VCHR',
        particulars: pm.referenceNo ? `Payment Ref: ${pm.referenceNo} ${pm.notes || ''}` : `Supplier Payment ${pm.notes || ''}`,
        billedAmount: 0,
        paidAmount: Number(pm.amount || 0),
        returnAmount: 0,
        paymentMode: pm.paymentMode || (pm as any).paymentMethod
      });
    });

    suppReturns.forEach((pr) => {
      rawItems.push({
        id: pr.id,
        date: pr.date || '',
        createdAt: pr.createdAt || pr.date || '',
        type: 'RETURN',
        typeLabel: 'PURCHASE RETURN',
        voucherNo: pr.returnNumber || 'PR-RET',
        particulars: pr.reason ? `Debit Note / Return - ${pr.reason}` : 'Purchase Return / Debit Note',
        billedAmount: 0,
        paidAmount: 0,
        returnAmount: Number(pr.grandTotal || 0)
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
      // Net balance change: + Billed - Paid - Return
      const netChange = item.billedAmount - item.paidAmount - item.returnAmount;
      runningBalance = Number((runningBalance + netChange).toFixed(2));
      return {
        ...item,
        netChange,
        runningBalance
      };
    });

    // 5. Total aggregations
    const totalBilled = rawItems.reduce((sum, item) => sum + item.billedAmount, 0);
    const totalPaid = rawItems.reduce((sum, item) => sum + item.paidAmount, 0);
    const totalReturns = rawItems.reduce((sum, item) => sum + item.returnAmount, 0);
    const finalCalculatedBalance = runningBalance;
    const storedBalance = Number(selectedLedgerSupplier.payableBalance || 0);

    // 6. Apply optional date filter to the displayed rows
    const displayedEntries = allCalculatedEntries.filter((item) => {
      if (statementStartDate && item.date < statementStartDate) return false;
      if (statementEndDate && item.date > statementEndDate) return false;
      return true;
    });

    return {
      openingBalance: openingBal,
      totalBilled,
      totalPaid,
      totalReturns,
      finalCalculatedBalance,
      storedBalance,
      isReconciled: Math.abs(finalCalculatedBalance - storedBalance) < 0.01,
      variance: Number((storedBalance - finalCalculatedBalance).toFixed(2)),
      entries: displayedEntries,
      totalEntriesCount: allCalculatedEntries.length
    };
  }, [selectedLedgerSupplier, purchases, payments, purchaseReturns, statementStartDate, statementEndDate]);

  // Form State
  const [formData, setFormData] = useState({
    code: '',
    name: '',
    companyName: '',
    phone: '',
    email: '',
    address: '',
    city: 'Colombo',
    openingBalance: '0'
  });

  const [formError, setFormError] = useState('');

  const handleOpenAdd = () => {
    setEditingSupplier(null);
    setFormError('');
    const codeCount = suppliers.length + 1;
    setFormData({
      code: `SUP-${String(codeCount).padStart(3, '0')}`,
      name: '',
      companyName: '',
      phone: '',
      email: '',
      address: '',
      city: 'Colombo',
      accountGroup: 'Sundry Creditors',
      openingBalance: '0'
    });
    setIsModalOpen(true);
  };

  const handleOpenEdit = (supp: Supplier) => {
    setEditingSupplier(supp);
    setFormError('');
    setFormData({
      code: supp.code,
      name: supp.name,
      companyName: supp.companyName || '',
      phone: supp.phone,
      email: supp.email || '',
      address: supp.address || '',
      city: supp.city || 'Colombo',
      accountGroup: supp.accountGroup || 'Sundry Creditors',
      openingBalance: (supp.openingBalance || 0).toString()
    });
    setIsModalOpen(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    if (!formData.name.trim()) {
      setFormError('Supplier / Vendor Name is required.');
      return;
    }

    if (!formData.phone.trim()) {
      setFormError('Phone Number is required.');
      return;
    }

    // Check duplicate supplier name or phone
    const duplicate = suppliers.find(
      (s) =>
        s.id !== editingSupplier?.id &&
        (s.name.trim().toLowerCase() === formData.name.trim().toLowerCase() ||
          s.phone.trim() === formData.phone.trim())
    );

    if (duplicate) {
      if (duplicate.name.trim().toLowerCase() === formData.name.trim().toLowerCase()) {
        setFormError(`A supplier named "${formData.name.trim()}" already exists.`);
        return;
      }
      if (duplicate.phone.trim() === formData.phone.trim()) {
        setFormError(`A supplier with phone number "${formData.phone.trim()}" already exists.`);
        return;
      }
    }

    onSaveSupplier({
      id: editingSupplier?.id,
      code: formData.code,
      name: formData.name.trim(),
      companyName: formData.companyName.trim(),
      phone: formData.phone.trim(),
      email: formData.email.trim(),
      address: formData.address.trim(),
      city: formData.city.trim(),
      accountGroup: formData.accountGroup || 'Sundry Creditors',
      openingBalance: Number(formData.openingBalance || 0)
    });

    setIsModalOpen(false);
  };

  // Dynamic accurate ledger balance for every supplier
  const supplierCalculatedBalances = useMemo(() => {
    const map = new Map<string, number>();
    suppliers.forEach((s) => {
      const suppCompId = s.companyId || 'comp-1';
      const suppPurchases = purchases.filter(
        (p) => p.supplierId === s.id && (!s.companyId || (p.companyId || 'comp-1') === suppCompId)
      );
      const suppPayments = payments.filter(
        (pm) => pm.supplierId === s.id && (!s.companyId || (pm.companyId || 'comp-1') === suppCompId)
      );
      const suppReturns = (purchaseReturns || []).filter(
        (pr) => pr.supplierId === s.id && (!s.companyId || (pr.companyId || 'comp-1') === suppCompId)
      );

      const totalBilled = suppPurchases.reduce((sum, p) => sum + Number(p.grandTotal || 0), 0);
      const totalPaid = suppPayments.reduce((sum, pm) => sum + Number(pm.amount || 0), 0);
      const totalReturns = suppReturns.reduce((sum, pr) => sum + Number(pr.grandTotal || 0), 0);
      const calculatedBal = Number((Number(s.openingBalance || 0) + totalBilled - totalPaid - totalReturns).toFixed(2));
      map.set(s.id, calculatedBal);
    });
    return map;
  }, [suppliers, purchases, payments, purchaseReturns]);

  // Filtered suppliers
  const filteredSuppliers = suppliers.filter((s) => {
    const q = searchTerm.toLowerCase().trim();
    const currentPayable = supplierCalculatedBalances.get(s.id) ?? s.payableBalance;
    if (!q) {
      return onlyPayable ? currentPayable > 0 : true;
    }
    const terms = q.split(/\s+/).filter(Boolean);
    const matchesQuery = terms.every((t) =>
      [s.name, s.code, s.phone, s.companyName || '', s.city || '', s.email || '']
        .join(' ')
        .toLowerCase()
        .includes(t)
    );
    return matchesQuery && (onlyPayable ? currentPayable > 0 : true);
  });

  const totalPayable = suppliers.reduce((sum, s) => sum + (supplierCalculatedBalances.get(s.id) ?? s.payableBalance), 0);

  return (
    <div className="space-y-6 pb-8">
      {/* Top Banner */}
      <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Supplier Management</h2>
          <p className="text-xs text-slate-500">Manage vendor profiles, purchase credit, and payables</p>
        </div>

        <div className="flex items-center gap-4">
          <div className="bg-rose-50 border border-rose-200 px-4 py-2 rounded-xl text-right">
            <span className="text-[10px] font-bold text-rose-700 uppercase block">Total Payable</span>
            <span className="text-lg font-black text-rose-900 font-mono">
              {settings.currencySymbol} {totalPayable.toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </span>
          </div>

          {canAdd && (
            <button
              onClick={handleOpenAdd}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-bold px-4 py-2.5 rounded-xl shadow-xs transition-all cursor-pointer text-sm"
            >
              <Plus className="w-4 h-4 text-yellow-400" />
              <span>Add Supplier</span>
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
            placeholder="Search by vendor, code, phone..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 rounded-xl border border-slate-200 text-sm focus:outline-hidden focus:border-blue-500"
          />
        </div>

        <label className="flex items-center gap-2 text-sm font-medium text-slate-700 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={onlyPayable}
            onChange={(e) => setOnlyPayable(e.target.checked)}
            className="w-4 h-4 text-blue-600 rounded-md border-slate-300 focus:ring-blue-500"
          />
          <span>Show Only Suppliers Owed Money (Payable &gt; 0)</span>
        </label>
      </div>

      {/* Supplier Cards Grid */}
      {filteredSuppliers.length === 0 ? (
        <div className="bg-white p-12 text-center rounded-2xl border border-slate-200 text-slate-400">
          No suppliers found matching your criteria.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredSuppliers.map((supp) => (
            <div
              key={supp.id}
              className="bg-white rounded-2xl border border-slate-200 shadow-xs p-5 hover:border-blue-300 transition-all flex flex-col justify-between"
            >
              <div>
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="px-2 py-0.5 bg-slate-100 text-slate-600 font-mono text-xs font-bold rounded-md">
                        {supp.code}
                      </span>
                      <span className="px-2 py-0.5 bg-rose-50 text-rose-700 text-[10px] font-bold rounded-md border border-rose-200">
                        {supp.accountGroup || 'Sundry Creditors'}
                      </span>
                    </div>
                    <h3 className="font-bold text-slate-900 text-base mt-1.5">{supp.name}</h3>
                    {supp.companyName && (
                      <p className="text-xs text-slate-500 flex items-center gap-1 mt-0.5">
                        <Building className="w-3 h-3 text-slate-400" />
                        <span>{supp.companyName}</span>
                      </p>
                    )}
                  </div>

                  <div className="text-right">
                    <span className="text-[10px] font-bold text-slate-400 uppercase block">Payable</span>
                    <span
                      className={`font-mono font-extrabold text-sm ${
                        (supplierCalculatedBalances.get(supp.id) ?? supp.payableBalance) > 0 ? 'text-rose-600' : 'text-emerald-600'
                      }`}
                    >
                      {settings.currencySymbol} {(supplierCalculatedBalances.get(supp.id) ?? supp.payableBalance).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>

                <div className="space-y-1.5 text-xs text-slate-600 mb-4 border-t border-slate-100 pt-3">
                  <div className="flex items-center gap-2">
                    <Phone className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <span>{supp.phone}</span>
                  </div>
                  {supp.email && (
                    <div className="flex items-center gap-2">
                      <Mail className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <span className="truncate">{supp.email}</span>
                    </div>
                  )}
                  {supp.address && (
                    <div className="flex items-center gap-2">
                      <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <span className="truncate">{supp.address}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Card Actions */}
              <div className="flex items-center justify-between border-t border-slate-100 pt-3 text-xs">
                <button
                  onClick={() => setSelectedLedgerSupplier(supp)}
                  className="text-blue-600 hover:text-blue-800 font-bold flex items-center gap-1 cursor-pointer"
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>Bills History</span>
                </button>

                <div className="flex items-center gap-2">
                  {canEdit && (
                    <button
                      onClick={() => handleOpenEdit(supp)}
                      className="p-1.5 hover:bg-slate-100 text-slate-600 rounded-lg cursor-pointer"
                      title="Edit Supplier"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                  )}
                  {canDelete && (
                    <button
                      onClick={() => setDeleteConfirmId(supp.id)}
                      className="p-1.5 hover:bg-rose-50 text-rose-600 rounded-lg cursor-pointer"
                      title="Delete Supplier"
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

      {/* Add / Edit Supplier Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full p-6 animate-in fade-in zoom-in-95">
            <div className="flex items-center justify-between pb-4 border-b border-slate-100">
              <h3 className="font-bold text-lg text-slate-900">
                {editingSupplier ? 'Edit Supplier' : 'Add New Supplier'}
              </h3>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {formError && (
              <div className="mt-4 p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{formError}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="mt-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                    Vendor Code
                  </label>
                  <input
                    type="text"
                    disabled
                    value={formData.code}
                    className="w-full p-2.5 rounded-xl border border-slate-200 bg-slate-50 text-sm font-mono text-slate-500 font-bold"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                    City / Town
                  </label>
                  <input
                    type="text"
                    value={formData.city}
                    onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                    className="w-full p-2.5 rounded-xl border border-slate-200 text-sm focus:border-blue-500"
                    placeholder="e.g. Colombo"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                  Contact Person / Supplier Name *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Ruwan Perera"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full p-2.5 rounded-xl border border-slate-200 text-sm focus:border-blue-500 font-bold"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                  Company / Distributor Business Name
                </label>
                <input
                  type="text"
                  placeholder="e.g. Perera & Sons Distributers Ltd"
                  value={formData.companyName}
                  onChange={(e) => setFormData({ ...formData, companyName: e.target.value })}
                  className="w-full p-2.5 rounded-xl border border-slate-200 text-sm focus:border-blue-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                    Phone Number *
                  </label>
                  <input
                    type="tel"
                    required
                    placeholder="077XXXXXXX"
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                    className="w-full p-2.5 rounded-xl border border-slate-200 text-sm font-mono focus:border-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                    Email Address
                  </label>
                  <input
                    type="email"
                    placeholder="vendor@mail.com"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    className="w-full p-2.5 rounded-xl border border-slate-200 text-sm focus:border-blue-500"
                  />
                </div>
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
                  <optgroup label="Liabilities / Trade Payables (Default)">
                    {STANDARD_ACCOUNT_GROUPS.filter((g) => g.nature === 'LIABILITY').map((g) => (
                      <option key={g.no} value={g.name}>
                        {g.no}. {g.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Other Account Groups">
                    {STANDARD_ACCOUNT_GROUPS.filter((g) => g.nature !== 'LIABILITY').map((g) => (
                      <option key={g.no} value={g.name}>
                        {g.no}. {g.name}
                      </option>
                    ))}
                  </optgroup>
                </select>
                <p className="text-[11px] text-slate-400 mt-1">
                  Default: 24. Sundry Creditors (Trade Suppliers)
                </p>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                  Warehouse / Office Address
                </label>
                <textarea
                  rows={2}
                  placeholder="No 45, Industrial Zone, Colombo 10"
                  value={formData.address}
                  onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                  className="w-full p-2.5 rounded-xl border border-slate-200 text-sm focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                  Opening Payable Balance ({settings.currencySymbol})
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={formData.openingBalance}
                  onChange={(e) => setFormData({ ...formData, openingBalance: e.target.value })}
                  className="w-full p-2.5 rounded-xl border border-slate-200 text-sm font-mono font-bold focus:border-blue-500"
                />
                <p className="text-[10px] text-slate-400 mt-1">
                  Initial amount you owe this supplier before recording transactions in BUSY UFO.
                </p>
              </div>

              <div className="pt-4 flex justify-end gap-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 rounded-xl text-slate-600 hover:bg-slate-100 font-bold text-sm"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="bg-blue-600 hover:bg-blue-700 text-white font-bold px-5 py-2 rounded-xl text-sm shadow-xs"
                >
                  {editingSupplier ? 'Update Supplier' : 'Save Supplier'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Supplier Bills History / Statement Modal */}
      {selectedLedgerSupplier && supplierStatementData && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 max-w-4xl w-full p-4 sm:p-6 animate-in fade-in zoom-in-95 max-h-[92vh] flex flex-col">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-slate-100 gap-3">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-bold text-lg text-slate-900">
                    {selectedLedgerSupplier.name}
                  </h3>
                  <span className="px-2 py-0.5 bg-slate-100 text-slate-700 text-xs font-mono font-bold rounded-md">
                    {selectedLedgerSupplier.code}
                  </span>
                  {selectedLedgerSupplier.accountGroup && (
                    <span className="px-2 py-0.5 bg-blue-50 text-blue-700 text-xs font-semibold rounded-md">
                      {selectedLedgerSupplier.accountGroup}
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  {selectedLedgerSupplier.companyName ? `${selectedLedgerSupplier.companyName} • ` : ''}
                  Phone: {selectedLedgerSupplier.phone} {selectedLedgerSupplier.address ? `• ${selectedLedgerSupplier.address}` : ''}
                </p>
              </div>

              <div className="flex items-center gap-2 self-end sm:self-auto">
                <button
                  onClick={() => window.print()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 cursor-pointer font-bold text-xs"
                  title="Print Statement"
                >
                  <Printer className="w-4 h-4" />
                  <span>Print</span>
                </button>
                <button
                  onClick={() => {
                    setSelectedLedgerSupplier(null);
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
            <div className="py-2.5 px-3 my-2 bg-slate-50 rounded-xl border border-slate-200/80 flex flex-wrap items-center justify-between gap-2 text-xs">
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
                {supplierStatementData.isReconciled ? (
                  <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 bg-emerald-100/80 px-2.5 py-0.5 rounded-md">
                    <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                    Ledger Reconciled
                  </span>
                ) : (
                  <>
                    <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-800 bg-amber-100/80 px-2.5 py-0.5 rounded-md" title={`Stored Balance: ${supplierStatementData.storedBalance.toFixed(2)} | Calculated: ${supplierStatementData.finalCalculatedBalance.toFixed(2)}`}>
                      <AlertCircle className="w-3 h-3 text-amber-600" />
                      Variance: {settings.currencySymbol} {Math.abs(supplierStatementData.variance).toFixed(2)}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        onSaveSupplier({
                          ...selectedLedgerSupplier,
                          payableBalance: supplierStatementData.finalCalculatedBalance
                        });
                        setSelectedLedgerSupplier({
                          ...selectedLedgerSupplier,
                          payableBalance: supplierStatementData.finalCalculatedBalance
                        });
                      }}
                      className="inline-flex items-center gap-1 text-[11px] font-bold text-white bg-amber-600 hover:bg-amber-700 px-2.5 py-0.5 rounded-md shadow-xs transition-colors cursor-pointer"
                      title="Update stored database balance to match exact ledger transactions"
                    >
                      <RefreshCw className="w-3 h-3" />
                      <span>Sync Balance ({settings.currencySymbol} {supplierStatementData.finalCalculatedBalance.toFixed(2)})</span>
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
                  {settings.currencySymbol} {supplierStatementData.openingBalance.toFixed(2)}
                </span>
              </div>
              <div className="bg-blue-50/60 p-2.5 rounded-xl border border-blue-100">
                <span className="text-[10px] text-blue-700 font-bold uppercase block">
                  (+) Total Billed
                </span>
                <span className="text-sm font-mono font-bold text-blue-900">
                  {settings.currencySymbol} {supplierStatementData.totalBilled.toFixed(2)}
                </span>
              </div>
              <div className="bg-emerald-50/60 p-2.5 rounded-xl border border-emerald-100">
                <span className="text-[10px] text-emerald-700 font-bold uppercase block">
                  (-) Total Paid
                </span>
                <span className="text-sm font-mono font-bold text-emerald-900">
                  {settings.currencySymbol} {supplierStatementData.totalPaid.toFixed(2)}
                </span>
              </div>
              <div className="bg-purple-50/60 p-2.5 rounded-xl border border-purple-100">
                <span className="text-[10px] text-purple-700 font-bold uppercase block">
                  (-) Debit Returns
                </span>
                <span className="text-sm font-mono font-bold text-purple-900">
                  {settings.currencySymbol} {supplierStatementData.totalReturns.toFixed(2)}
                </span>
              </div>
              <div className="col-span-2 sm:col-span-1 bg-rose-50 p-2.5 rounded-xl border border-rose-200">
                <span className="text-[10px] text-rose-700 font-bold uppercase block">
                  (=) Net Payable
                </span>
                <span className="text-sm font-mono font-black text-rose-900">
                  {settings.currencySymbol} {supplierStatementData.finalCalculatedBalance.toFixed(2)}
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
                    <th className="p-2.5 text-right">Paid/Ret (-Cr)</th>
                    <th className="p-2.5 text-right">Running Payable</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono">
                  {/* Opening Balance Line */}
                  <tr className="bg-slate-50/60 font-semibold">
                    <td className="p-2.5 text-slate-500">-</td>
                    <td className="p-2.5 text-slate-500">OB-000</td>
                    <td className="p-2.5 font-sans text-slate-700">Opening Ledger Balance</td>
                    <td className="p-2.5 text-right text-slate-700">{supplierStatementData.openingBalance.toFixed(2)}</td>
                    <td className="p-2.5 text-right text-slate-400">0.00</td>
                    <td className="p-2.5 text-right font-bold text-slate-800">{supplierStatementData.openingBalance.toFixed(2)}</td>
                  </tr>

                  {supplierStatementData.entries.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="p-6 text-center text-slate-400 font-sans italic">
                        No transactions recorded for this supplier within the selected period.
                      </td>
                    </tr>
                  ) : (
                    supplierStatementData.entries.map((entry) => (
                      <tr key={entry.id} className="hover:bg-slate-50/80 transition-colors">
                        <td className="p-2.5 text-slate-600 whitespace-nowrap">{entry.date}</td>
                        <td className="p-2.5 font-bold text-blue-700 whitespace-nowrap">{entry.voucherNo}</td>
                        <td className="p-2.5 font-sans text-slate-800">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                              entry.type === 'PURCHASE' ? 'bg-amber-100 text-amber-800' :
                              entry.type === 'PAYMENT' ? 'bg-emerald-100 text-emerald-800' :
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
                          {entry.paidAmount > 0 ? entry.paidAmount.toFixed(2) : entry.returnAmount > 0 ? entry.returnAmount.toFixed(2) : '-'}
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
                    <td className="p-2.5 text-right font-mono text-slate-900">{supplierStatementData.totalBilled.toFixed(2)}</td>
                    <td className="p-2.5 text-right font-mono text-emerald-800">{(supplierStatementData.totalPaid + supplierStatementData.totalReturns).toFixed(2)}</td>
                    <td className="p-2.5 text-right font-mono text-rose-900">{supplierStatementData.finalCalculatedBalance.toFixed(2)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Footer */}
            <div className="pt-3 mt-1 flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-t border-slate-100">
              <span className="text-xs text-slate-500">
                Showing {supplierStatementData.entries.length} of {supplierStatementData.totalEntriesCount} transactional records
              </span>
              <button
                onClick={() => {
                  setSelectedLedgerSupplier(null);
                  setStatementStartDate('');
                  setStatementEndDate('');
                }}
                className="px-4 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs self-end"
              >
                Close Statement
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirmId && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-sm w-full p-6 animate-in fade-in zoom-in-95 text-center">
            <div className="w-12 h-12 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center mx-auto mb-3">
              <Trash2 className="w-6 h-6" />
            </div>
            <h3 className="font-bold text-base text-slate-900">Delete Supplier Record?</h3>
            <p className="text-xs text-slate-500 mt-1">
              Are you sure? This supplier will be deleted from your address book.
            </p>
            <div className="mt-5 flex justify-center gap-3">
              <button
                onClick={() => setDeleteConfirmId(null)}
                className="px-4 py-2 rounded-xl text-slate-600 hover:bg-slate-100 font-bold text-xs"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  onDeleteSupplier(deleteConfirmId);
                  setDeleteConfirmId(null);
                }}
                className="bg-rose-600 hover:bg-rose-700 text-white font-bold px-4 py-2 rounded-xl text-xs shadow-xs"
              >
                Delete Supplier
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
