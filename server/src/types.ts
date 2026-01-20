export type GameEdition = {
  id: string;
  name: string;
  description: string;
  price: number;
  badge?: string; // например: Выгодно
};

export type Game = {
  id: string;
  title: string;
  description: string;
  rating: number;
  tags: string[];
  author: string;
  coverUrl: string;
  gallery: string[];
  rules: string;
  editions: GameEdition[];
};

export type Profile = {
  id: string;
  name: string;
  avatarUrl: string;
  subscriptionUntil: string; // ISO
  totalEarned: number;
  totalFriends: number;
  autoRenewal: boolean;
  cardMasked: string;
};

export type Friend = {
  id: string;
  name: string;
  avatarUrl: string;
};

export type User = {
  id: string;
  firstName: string;
  lastName: string;
  tgUsername?: string;
  tgId?: string;
  subscriptionType?: 'free' | 'premium' | 'trial';
  status: 'active' | 'blocked';
  registeredAt: string; // ISO
  balance: number; // монет
  referrerTgId?: string;
  referralsCount: number;
  subscriptionUntil?: string; // ISO
  lastSeenAt?: string; // ISO
};

export type Feedback = {
  id: string;
  userId: string;
  gameId?: string;
  rating: number;
  comment?: string;
  createdAt: string; // ISO
};

export type SubscriptionPlan = {
  id: string;
  title: string; // месяц, 6 месяцев, 12 месяцев
  description: string;
  price: number;
  durationDays: number;
  badge?: string;
};

export type Character = {
  id: string;
  gameId?: string;
  name: string;
  gender?: string;
  race?: string;
  avatarUrl: string;
  description?: string;
  rating?: number;
  
  // D&D 5e Stats
  level?: number;
  class?: string;
  hp?: number;
  maxHp?: number;
  ac?: number;
  str?: number;
  dex?: number;
  con?: number;
  int?: number;
  wis?: number;
  cha?: number;
  skills?: any;
  inventory?: any;
  spells?: any;
  equipment?: any;
};


