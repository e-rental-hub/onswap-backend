export interface PiTransferResult {
  success: boolean;
  txId?: string;
  error?: string;
}

export interface CreditResult {
  newBalance:    number;
  netAmount:     number;
  fee:           number;
  transactionId: string;
}