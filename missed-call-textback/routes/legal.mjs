/**
 * GET /privacy, /terms, /data-deletion — public, static legal pages.
 *
 * No session and no store: these must load for anyone, including Meta's
 * reviewers and a caller who has never had an account.
 */
import { privacyPage, termsPage, dataDeletionPage } from "../lib/legalViews.mjs";

export const handlePrivacy = () => ({ status: 200, html: privacyPage() });
export const handleTerms = () => ({ status: 200, html: termsPage() });
export const handleDataDeletion = () => ({ status: 200, html: dataDeletionPage() });
