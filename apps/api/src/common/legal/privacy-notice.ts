import { BadRequestException } from '@nestjs/common';

/**
 * FR-PRIV-01: "The system shall present a privacy notice at registration
 * stating what data is collected, the purpose, the retention period, and the
 * contact point for grievances."
 *
 * The version is a date. Bump it whenever the text below changes in meaning:
 * acceptance is recorded against the version the person was actually shown.
 *
 * The wording is a plain description of what this codebase does with data.
 * It has not been reviewed by a lawyer — see
 * /home/claude/requests/A5-DECISION-privacy-notice-text.md.
 */
export const PRIVACY_NOTICE_VERSION = '2026-11-20';

export const PRIVACY_NOTICE_SECTIONS = [
  {
    key: 'dataCollected',
    heading: 'What we collect',
    body:
      'Your name, mobile number, email address and college. For verification: your roll ' +
      'number, department, year of study and a photo of your college ID card; where your ' +
      'college asks for a government ID, only its type and last four characters. When you ' +
      'order or deliver: the orders, tasks, delivery points and wallet entries involved. ' +
      'While you are in work mode as a rider: your location. For shops: the owner’s contact ' +
      'details, the shop address and the licence documents submitted for approval.',
  },
  {
    key: 'purpose',
    heading: 'Why we collect it',
    body:
      'To confirm you belong to your college, to take and deliver orders within your campus, ' +
      'to pay riders and settle with shops, to resolve disputes, and to keep the service ' +
      'safe. A rider’s live location is shown only to the person whose task they are ' +
      'carrying, and only between assignment and delivery. Your mobile number is never ' +
      'shown to other students.',
  },
  {
    key: 'retention',
    heading: 'How long we keep it',
    body:
      'Your profile is kept while your account is open. When you delete your account your ' +
      'name, mobile number, email, roll number and identity documents are erased ' +
      'immediately. Records of orders, deliveries and wallet entries, and the audit log, ' +
      'are kept without your personal details because they are needed for settlement and ' +
      'dispute resolution. Task chat history is kept for the period your college ' +
      'configures (180 days by default) after a task closes.',
  },
  {
    key: 'grievance',
    heading: 'Who to contact',
    body:
      'You can export your data or delete your account at any time from Account & data. ' +
      'For any concern about your data, contact the grievance contact shown below, or your ' +
      'campus administrator.',
  },
] as const;

export interface PrivacyNoticeEnv {
  PRIVACY_GRIEVANCE_NAME?: string;
  PRIVACY_GRIEVANCE_EMAIL?: string;
  PRIVACY_ACCEPTANCE_REQUIRED?: string;
}

export function privacyAcceptanceRequired(env: PrivacyNoticeEnv): boolean {
  return env.PRIVACY_ACCEPTANCE_REQUIRED === 'true';
}

/** The public representation: what the signup screen renders. */
export function privacyNotice(env: PrivacyNoticeEnv) {
  return {
    version: PRIVACY_NOTICE_VERSION,
    effectiveFrom: PRIVACY_NOTICE_VERSION,
    title: 'Hoppo privacy notice',
    sections: PRIVACY_NOTICE_SECTIONS,
    grievanceContact: {
      name: env.PRIVACY_GRIEVANCE_NAME ?? null,
      email: env.PRIVACY_GRIEVANCE_EMAIL ?? null,
    },
    acceptanceRequired: privacyAcceptanceRequired(env),
  };
}

/**
 * Decide what a registration's `privacyNoticeVersion` means.
 *
 * Returns the version to record as accepted, or null when none was sent and
 * none is required. Throws for a version that is not the current one — the
 * person agreed to a text that is no longer the notice — and, once acceptance
 * is required, for a registration that carries none.
 */
export function acceptedPrivacyVersion(
  sent: string | undefined | null,
  env: PrivacyNoticeEnv,
): string | null {
  if (sent === undefined || sent === null || sent === '') {
    if (privacyAcceptanceRequired(env)) {
      throw new BadRequestException({
        code: 'PRIVACY_NOTICE_NOT_ACCEPTED',
        message: 'Read and accept the privacy notice to create an account.',
        details: { currentVersion: PRIVACY_NOTICE_VERSION },
      });
    }
    return null;
  }

  if (sent !== PRIVACY_NOTICE_VERSION) {
    throw new BadRequestException({
      code: 'PRIVACY_NOTICE_OUTDATED',
      message: 'The privacy notice has been updated. Please read the current version.',
      details: { currentVersion: PRIVACY_NOTICE_VERSION },
    });
  }

  return sent;
}
