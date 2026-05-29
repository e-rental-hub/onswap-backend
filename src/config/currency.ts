export type Currency = 'NGN' | 'KES';

export const CURRENCIES: Record<Currency, { symbol: string; name: string; flag: string }> = {
  NGN: { symbol: '₦',   name: 'Nigerian Naira',   flag: '🇳🇬' },
  KES: { symbol: 'KSh', name: 'Kenyan Shilling',   flag: '🇰🇪' },
};

export function currencySymbol(currency: string): string {
  return CURRENCIES[currency as Currency]?.symbol ?? currency;
}

export function formatAmount(amount: number, currency: string): string {
  const symbol = currencySymbol(currency);
  return `${symbol}${amount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export const CURRENCY_PAYMENT_METHODS: Record<Currency, { value: string; label: string }[]> = {
  NGN: [
    { value: 'bank_transfer', label: 'Bank Transfer' },
    { value: 'opay',          label: 'OPay'          },
    { value: 'palmpay',       label: 'PalmPay'       },
    { value: 'kuda',          label: 'Kuda Bank'     },
    { value: 'moniepoint',    label: 'Moniepoint'    },
  ],
  KES: [
    { value: 'mpesa',         label: 'M-Pesa'        },
    { value: 'airtel_money',  label: 'Airtel Money'  },
    { value: 'bank_transfer', label: 'Bank Transfer'  },
    { value: 'equity',        label: 'Equity Bank'   },
    { value: 'kcb',           label: 'KCB Bank'      },
  ],
};

export function getPaymentMethods(currency: string) {
  return CURRENCY_PAYMENT_METHODS[currency as Currency] ?? CURRENCY_PAYMENT_METHODS.NGN;
}