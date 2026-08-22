/**
 * CleanBid type definitions.
 * JSDoc-style for IDE support without TypeScript build step.
 */

/** @typedef {{ id: string, email: string, full_name?: string, avatar_url?: string }} User */
/** @typedef {{ id: string, workspace_id: string, name: string, slug?: string, branding?: object, pricing_defaults?: object }} Workspace */
/** @typedef {{ id: string, workspace_id: string, user_id: string, role: 'owner' | 'admin' | 'estimator' | 'sales' }} WorkspaceMember */

/** @typedef {{ id: string, workspace_id?: string, company: string, contact?: string, email?: string, phone?: string, address?: string, notes?: string, last_activity?: string }} Customer */
/** @typedef {{ id: string, workspace_id?: string, customer_id?: string, name: string, address?: string, type?: string, sqft?: number, floors?: number, quote_count?: number, last_quoted?: string }} Property */
/** @typedef {{ id: string, workspace_id?: string, customer_id?: string, property_id?: string, property_name: string, company_name: string, contact?: string, email?: string, phone?: string, property_address?: string, sqft?: number, floors?: number, type?: string, frequency?: number, package?: string, profile_id?: string, profile_name?: string, areas?: any[], tasks?: any[], addons?: any[], cleaners?: number, hours_per_visit?: number, visits_per_month?: number, monthly?: number, annual?: number, margin?: number, cost_per_visit?: number, labor_per_visit?: number, burden_per_visit?: number, supplies_per_visit?: number, overhead_per_visit?: number, addons_per_visit?: number, status?: string, version?: number, versions?: any[], followup?: string, lost_reason?: string, price_snap?: object, productivity_snap?: object, calc_monthly?: number, override?: object, date?: string, modified?: string }} Quote */
/** @typedef {{ id: string, workspace_id?: string, name: string, wage: number, burden: number, overhead: number, margin: number, min_price?: number, supplies?: number, productivity?: object, is_default?: boolean }} PricingProfile */
/** @typedef {{ id: string, workspace_id: string, user_id?: string, action: string, entity_type: string, entity_id?: string, metadata?: object }} ActivityLog */

export {};
