import {
  ShoppingCart, Utensils, Car, Home, Zap, Film, ShoppingBag, HeartPulse,
  Plane, Repeat, Briefcase, Laptop, Megaphone, Handshake, Wrench, Users,
  Receipt, Tag
} from 'lucide-react'

const ICON_MAP = {
  // Personal categories
  'Groceries': ShoppingCart,
  'Dining': Utensils,
  'Transport': Car,
  'Rent/Housing': Home,
  'Utilities': Zap,
  'Entertainment': Film,
  'Shopping': ShoppingBag,
  'Health': HeartPulse,
  'Travel': Plane,
  'Subscriptions': Repeat,
  // Business categories
  'Office Supplies': Briefcase,
  'Client Meals': Utensils,
  'Software & Subscriptions': Laptop,
  'Business Travel': Plane,
  'Marketing': Megaphone,
  'Professional Services': Handshake,
  'Equipment': Wrench,
  'Rent/Utilities': Home,
  'Payroll': Users,
  // "Other purpose" set
  'Bills': Receipt,
  // Fallback
  'Other': Tag
}

export default function CategoryIcon({ category, className = 'w-3.5 h-3.5' }) {
  const Icon = ICON_MAP[category] || Tag
  return <Icon className={className} />
}
