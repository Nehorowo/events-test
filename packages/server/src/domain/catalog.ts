export interface Company {
  companyId: string;
  symbol: string;
  name: string;
  /** Event type id, mirroring a real reference table (1 = earnings call). */
  typeId: number;
}

/** Ten symbols — the "certain set of companies" the page subscribes to. */
export const COMPANIES: readonly Company[] = [
  { companyId: 'c-aapl', symbol: 'AAPL', name: 'Apple Inc.', typeId: 1 },
  { companyId: 'c-msft', symbol: 'MSFT', name: 'Microsoft Corp.', typeId: 1 },
  { companyId: 'c-nvda', symbol: 'NVDA', name: 'NVIDIA Corp.', typeId: 1 },
  { companyId: 'c-amzn', symbol: 'AMZN', name: 'Amazon.com Inc.', typeId: 1 },
  { companyId: 'c-googl', symbol: 'GOOGL', name: 'Alphabet Inc.', typeId: 1 },
  { companyId: 'c-meta', symbol: 'META', name: 'Meta Platforms Inc.', typeId: 1 },
  { companyId: 'c-tsla', symbol: 'TSLA', name: 'Tesla Inc.', typeId: 1 },
  { companyId: 'c-nflx', symbol: 'NFLX', name: 'Netflix Inc.', typeId: 2 },
  { companyId: 'c-amd', symbol: 'AMD', name: 'Advanced Micro Devices', typeId: 1 },
  { companyId: 'c-crm', symbol: 'CRM', name: 'Salesforce Inc.', typeId: 2 },
];

export const COMPANY_BY_SYMBOL = new Map(COMPANIES.map((c) => [c.symbol, c]));

export const ALL_SYMBOLS = COMPANIES.map((c) => c.symbol);
