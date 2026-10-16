/**
 * Users, memberships and roles.
 *
 * Until now there was one shared password per business, which meant every
 * login was the same principal and roles could only have been theatre.
 * This introduces real accounts so authorization has something true to be
 * derived from.
 *
 * The session carries the user id; the business and role are resolved
 * from the stored membership on every request. Nothing about the request
 * body or query string participates — a role a client sends is ignored,
 * not validated.
 */
import crypto from "node:crypto";
import { hashPassword, verifyPassword } from "./auth.mjs";

export const ROLES = ["OWNER", "ADMIN", "STAFF"];

export function isValidRole(role) {
  return ROLES.includes(role);
}

/**
 * What each role may do. Deliberately small: three verbs, because
 * inventing a finer permission matrix than the product actually has
 * creates the illusion of control without the substance.
 */
const PERMISSIONS = {
  OWNER: { viewLeads: true, manageSettings: true, manageTeam: true },
  ADMIN: { viewLeads: true, manageSettings: true, manageTeam: false },
  STAFF: { viewLeads: true, manageSettings: false, manageTeam: false },
};

export function can(role, permission) {
  return Boolean(PERMISSIONS[role]?.[permission]);
}

export function normaliseEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

export function isValidEmail(email) {
  const e = normaliseEmail(email);
  return e.length >= 3 && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

/** Long enough to be worth hashing; the real protection is scrypt plus rate limiting. */
export function isAcceptablePassword(password) {
  return typeof password === "string" && password.length >= 10 && password.length <= 200;
}

export function createUser({ email, password }) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    email: normaliseEmail(email),
    passwordHash: hashPassword(password),
    createdAt: now,
    updatedAt: now,
  };
}

export function createMembership({ userId, businessId, role }) {
  if (!isValidRole(role)) throw new Error(`unknown role: ${role}`);
  return {
    id: crypto.randomUUID(),
    userId,
    businessId,
    role,
    createdAt: new Date().toISOString(),
  };
}

/** Never includes passwordHash. Built by naming safe fields, not removing unsafe ones. */
export function publicUser(user) {
  if (!user) return null;
  return { id: user.id, email: user.email, createdAt: user.createdAt };
}

export function createAccountService(store) {
  return {
    async findByEmail(email) {
      return store.getUserByEmail(normaliseEmail(email));
    },

    /**
     * Registers a user. Returns null when the email is taken rather than
     * throwing a distinguishable error, so signup can't be used to
     * enumerate which addresses already have accounts.
     */
    async signUp({ email, password }) {
      if (!isValidEmail(email) || !isAcceptablePassword(password)) return null;
      if (await store.getUserByEmail(normaliseEmail(email))) return null;
      const user = createUser({ email, password });
      await store.saveUser(user);
      return user;
    },

    async authenticate({ email, password }) {
      const user = await store.getUserByEmail(normaliseEmail(email));
      // Hash even when the user is absent so a missing account and a wrong
      // password take comparable time and can't be told apart.
      const hash = user?.passwordHash ?? hashPassword("no-such-user-placeholder");
      const ok = verifyPassword(String(password ?? ""), hash);
      return ok && user ? user : null;
    },

    /** Replaces a user's password. False for an unknown user or an unacceptable password. */
    async setPassword(userId, password) {
      if (!isAcceptablePassword(password)) return false;
      const user = await store.getUser(userId);
      if (!user) return false;
      await store.saveUser({ ...user, passwordHash: hashPassword(password), updatedAt: new Date().toISOString() });
      return true;
    },

    /**
     * Creates a business and makes its creator OWNER. The role is set
     * here, server-side — a client cannot nominate itself OWNER because
     * the value never comes from the request.
     */
    async createBusinessFor(user, business) {
      await store.saveBusiness(business);
      const membership = createMembership({ userId: user.id, businessId: business.id, role: "OWNER" });
      await store.saveMembership(membership);
      return membership;
    },

    async membershipsOf(userId) {
      return (await store.listMembershipsByUser(userId)) ?? [];
    },

    async membershipFor(userId, businessId) {
      const all = (await store.listMembershipsByUser(userId)) ?? [];
      return all.find((m) => m.businessId === businessId) ?? null;
    },

    async membersOf(businessId) {
      return (await store.listMembershipsByBusiness(businessId)) ?? [];
    },

    async addMember({ businessId, email, role }) {
      if (!isValidRole(role) || role === "OWNER") return null; // ownership isn't granted this way
      const user = await store.getUserByEmail(normaliseEmail(email));
      if (!user) return null;
      const existing = await this.membershipFor(user.id, businessId);
      if (existing) return existing;
      const membership = createMembership({ userId: user.id, businessId, role });
      await store.saveMembership(membership);
      return membership;
    },

    async removeMember({ businessId, membershipId }) {
      const members = await this.membersOf(businessId);
      const target = members.find((m) => m.id === membershipId);
      // The last OWNER cannot be removed, or the business becomes
      // unadministrable with no way back in.
      if (!target || target.role === "OWNER") return false;
      await store.deleteMembership(membershipId);
      return true;
    },
  };
}

/**
 * Resolves who the request is acting as. Everything authorization needs
 * comes from the session and the stored membership; nothing is read from
 * the request itself.
 */
export async function resolveActor(session, accounts) {
  if (!session) return null;

  // Legacy per-business credential sessions predate user accounts. They
  // act as OWNER of their own business and carry no user.
  // TODO(remove): drop once the default business has a real account.
  if (!session.userId) {
    return session.businessId
      ? { user: null, businessId: session.businessId, role: "OWNER", legacy: true }
      : null;
  }

  // Without an accounts service there is no membership to verify against,
  // and an unverifiable user session must not be trusted.
  if (!accounts) return null;

  let membership;
  if (session.businessId) {
    // A session pinned to a business is honoured only while that
    // membership exists; it never silently becomes another tenant.
    membership = await accounts.membershipFor(session.userId, session.businessId);
  } else {
    // A session minted before the user had a business (signup, or a team
    // invite accepted later) carries no businessId. It used to resolve to
    // no tenant while onboarding saw the membership and bounced back — an
    // endless /leads <-> /onboarding redirect. The fallback comes from the
    // stored membership, never from the request.
    membership = ((await accounts.membershipsOf(session.userId)) ?? [])[0] ?? null;
  }
  if (!membership) return null;
  return { user: { id: session.userId }, businessId: membership.businessId, role: membership.role, legacy: false };
}
