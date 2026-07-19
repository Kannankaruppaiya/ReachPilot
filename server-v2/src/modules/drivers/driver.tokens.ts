/**
 * DI tokens for the swappable automation drivers.
 * The concrete provider is chosen in drivers.module.ts based on env.
 */
export const LINKEDIN_DRIVER = Symbol('LINKEDIN_DRIVER');
export const EMAIL_DRIVER = Symbol('EMAIL_DRIVER');
