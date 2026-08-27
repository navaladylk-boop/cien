const fs = require('fs');
let code = fs.readFileSync('src/components/Purchases.tsx', 'utf-8');

const stateCode = `  const [excelPasteData, setExcelPasteData] = useState<{
    isOpen: boolean;
    rows: string[][];
    mapping: Record<string, number>;
  }>({ isOpen: false, rows: [], mapping: {} });`;

code = code.replace("const [searchTerm, setSearchTerm] = useState('');", "const [searchTerm, setSearchTerm] = useState('');\n" + stateCode);
fs.writeFileSync('src/components/Purchases.tsx', code);
