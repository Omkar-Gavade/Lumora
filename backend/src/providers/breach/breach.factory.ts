import { env } from '../../config/index.js';
import type { BreachChecker } from './breach-checker.interface.js';
import { HibpBreachChecker, NoopBreachChecker } from './hibp.checker.js';

export function createBreachChecker(): BreachChecker {
  return env.PASSWORD_BREACH_CHECK ? new HibpBreachChecker() : new NoopBreachChecker();
}

export const breachChecker: BreachChecker = createBreachChecker();
