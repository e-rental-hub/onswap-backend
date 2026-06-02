export enum AdTypeEnum {
  buy  = 'buy',
  sell = 'sell',
}

export enum AdStatusEnum {
  active    = 'active',
  paused    = 'paused',
  completed = 'completed',
  cancelled = 'cancelled',
}

export enum PaymentMethodEnum {
  bankTransfer = 'bank_transfer',
  // opay         = 'opay',
  // palmpay      = 'palmpay',
  // kuda         = 'kuda',
  // moniepoint   = 'moniepoint',
  // cashDeposit  = 'cash_deposit',  // merged from removed PaymentAccMethodEnum
}

export enum MessageTypeEnum {
  text         = 'text',
  system       = 'system',
  paymentProof = 'payment_proof',
}

export enum OrderStatusEnum {
  paymentPending = 'payment_pending',  // buyer needs to send Naira
  paymentSent    = 'payment_sent',     // buyer confirmed; seller to verify & release
  completed      = 'completed',        // seller released Pi
  disputed       = 'disputed',         // either party raised a dispute
  cancelled      = 'cancelled',        // cancelled before payment sent
  refunded       = 'refunded',         // Pi returned after dispute resolution
}

export enum EscrowStatusEnum {
  pending  = 'pending',
  locked   = 'locked',
  released = 'released',
  refunded = 'refunded',
}

export enum CurrencyEnum {
  NGN        = 'NGN',
  KES = 'KES',
}