/**
 * Single source of truth for every path. Components never hardcode a route
 * string — a rename here is a compile error everywhere it matters.
 */
export const ROUTES = {
  home: '/',
  privacy: '/privacy',
  terms: '/terms',

  login: '/login',
  signup: '/signup',
  forgotPassword: '/forgot-password',
  resetPassword: '/reset-password',
  verifyEmail: '/verify-email',

  app: '/app',
  chat: '/app/chat',
  knowledge: '/app/knowledge',
  documents: '/app/documents',
  search: '/app/search',
  settings: '/app/settings',
  serverError: '/500',
} as const;

/** Path builders for routes that take a parameter. */
export const buildRoute = {
  conversation: (id: string) => `${ROUTES.chat}/${id}`,
  knowledgeBase: (id: string) => `${ROUTES.knowledge}/${id}`,
} as const;

/** Homepage section anchors, used by both the nav and the sections themselves. */
export const SECTIONS = {
  features: 'features',
  howItWorks: 'how-it-works',
  whyRag: 'why-rag',
  useCases: 'use-cases',
  privacy: 'privacy',
  faq: 'faq',
} as const;

export const anchor = (id: (typeof SECTIONS)[keyof typeof SECTIONS]) => `/#${id}`;
