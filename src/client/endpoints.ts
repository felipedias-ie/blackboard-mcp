import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { profilePath, stateDir, ensureDir } from '../lib/paths.js';
import { log } from '../lib/logger.js';

/**
 * Endpoint templates for the Blackboard Learn **Ultra internal API**
 * (`/learn/api/v1/*`). The surface the Ultra web client itself calls with
 * nothing but the session cookie.
 *
 * This is deliberately NOT the documented `/learn/api/public/v1/*` REST API.
 * The public API requires an OAuth application registered and approved by the
 * institution's Blackboard administrator; the internal one is what a signed-in
 * browser uses, so it works with a captured session and exposes strictly more
 * (to-do lists, activity stream, conversations, discussion state, attendance).
 *
 * Verified against a 3,609-entry HAR capture of a live Ultra tenant and
 * cross-checked against several independent open-source clients.
 *
 * Placeholders are `{name}`, substituted by `expand()`. Every template is
 * overridable from `~/.blackboard-mcp/endpoints.json` so a tenant on a
 * different Learn release, or behind a path-rewriting proxy, can be corrected
 * without a code change. See `blackboard-mcp har import`.
 */
export const DEFAULT_ENDPOINTS = {
  // ── identity & session ──────────────────────────────────────────────────
  self: '/learn/api/v1/users/me',
  user: '/learn/api/v1/users/{userId}',
  selfMemberships: '/learn/api/v1/users/me/memberships',
  userMemberships: '/learn/api/v1/users/{userId}/memberships',
  /** Seconds until the session goes inactive. The cheapest liveness probe. */
  sessionTtl: '/learn/api/v1/utilities/timeUntilBbSessionInactive',
  /** Extends the session without doing real work. */
  sessionKeepAlive: '/learn/api/v1/utilities/keepBbSessionActive',
  systemVersion: '/learn/api/v1/system/version',
  /** PUT a list of `{method, relativeUrl}` to fan out many reads in one trip. */
  batch: '/learn/api/v1/utilities/batch',

  // ── courses ─────────────────────────────────────────────────────────────
  course: '/learn/api/v1/courses/{courseId}',
  courseRoster: '/learn/api/v1/courses/{courseId}/memberships',
  courseMembershipCount: '/learn/api/v1/courses/{courseId}/memberships/count',
  courseUser: '/learn/api/v1/courses/{courseId}/users/{userId}',
  courseTools: '/learn/api/v1/courses/{courseId}/tools',
  courseEntitlements: '/learn/api/v1/courses/{courseId}/entitlements',
  courseSchedule: '/learn/api/v1/courses/{courseId}/schedule',
  courseMeetings: '/learn/api/v1/courses/{courseId}/meetings',
  courseGroups: '/learn/api/v1/courses/{courseId}/groups',
  courseGroupSets: '/learn/api/v1/courses/{courseId}/groupsets',
  terms: '/learn/api/v1/terms',

  // ── content tree ────────────────────────────────────────────────────────
  /** Top level of a course outline. `ROOT` is a literal sentinel id. */
  contentsRoot: '/learn/api/v1/courses/{courseId}/contents/ROOT/children',
  /**
   * The *second* content root. Ultra keeps discussions, journals and other
   * participation activities outside the main outline, under the literal
   * sentinel `INTERACTIVE`. Walking only ROOT silently misses them.
   */
  contentsInteractive: '/learn/api/v1/courses/{courseId}/contents/INTERACTIVE/children',
  content: '/learn/api/v1/courses/{courseId}/contents/{contentId}',
  contentChildren: '/learn/api/v1/courses/{courseId}/contents/{contentId}/children',
  contentAttachments: '/learn/api/v1/courses/{courseId}/contents/{contentId}/attachments',
  contentAttachmentDownload:
    '/learn/api/v1/courses/{courseId}/contents/{contentId}/attachments/{attachmentId}/download',
  /** Per-user "mark reviewed" state; PATCH `{reviewed: true}`. */
  contentState: '/learn/api/v1/courses/{courseId}/contents/{contentId}/states/me',
  contentIndicators: '/learn/api/v1/courses/{courseId}/contents/indicators',
  /** The root nodes themselves (as opposed to their children). */
  contentsRootNode: '/learn/api/v1/courses/{courseId}/contents/ROOT',
  contentsInteractiveNode: '/learn/api/v1/courses/{courseId}/contents/INTERACTIVE',
  /** Other places a content item is linked from. */
  contentSoftLinks: '/learn/api/v1/courses/{courseId}/contents/{contentId}/softLinks',

  // ── gradebook ───────────────────────────────────────────────────────────
  gradeColumns: '/learn/api/v1/courses/{courseId}/gradebook/columns',
  gradeColumn: '/learn/api/v1/courses/{courseId}/gradebook/columns/{columnId}',
  finalGrade: '/learn/api/v1/courses/{courseId}/gradebook/columns/finalGrade',
  /** Student-facing grade list; takes `userId` as a query parameter. */
  grades: '/learn/api/v1/courses/{courseId}/gradebook/grades',
  columnGrades: '/learn/api/v1/courses/{courseId}/gradebook/columns/{columnId}/grades',
  attempt: '/learn/api/v1/courses/{courseId}/gradebook/attempts/{attemptId}',
  /**
   * GET lists a column's attempts. POST creates a draft attempt, which is the
   * first half of submitting work; the body carries `status: "IN_PROGRESS"`.
   */
  columnAttempts: '/learn/api/v1/courses/{courseId}/gradebook/columns/{columnId}/attempts',
  /** Per-student due-date exceptions. POST with `{membershipIds:[...]}` reads them. */
  columnExceptions: '/learn/api/v1/courses/{courseId}/gradebook/columns/{columnId}/exceptions',
  attemptFiles:
    '/learn/api/v1/courses/{courseId}/gradebook/columns/{columnId}/attempts/{attemptId}/files',
  attemptFileDownload:
    '/learn/api/v1/courses/{courseId}/gradebook/columns/{columnId}/attempts/{attemptId}/files/{fileId}/download',
  gradeSchemas: '/learn/api/v1/courses/{courseId}/gradebook/schemas',
  /** One grading schema: maps numeric scores onto letter/pass-fail grades. */
  gradeSchema: '/learn/api/v1/courses/{courseId}/gradebook/schemas/{schemaId}',
  /** Per-student due-date and time-limit exceptions (extensions). */
  gradebookExceptions:
    '/learn/api/v1/courses/{courseId}/gradebook/memberships/{membershipId}/exceptions',
  gradebookSettings: '/learn/api/v1/courses/{courseId}/gradebook/settings',
  unreadGradesCount: '/learn/api/v1/courses/{courseId}/gradebook/unreadGradesCount',

  // ── announcements ───────────────────────────────────────────────────────
  courseAnnouncements: '/learn/api/v1/courses/{courseId}/announcements',
  announcementCounts: '/learn/api/v1/courses/{courseId}/announcements/counts',

  // ── calendar & deadlines ────────────────────────────────────────────────
  calendars: '/learn/api/v1/calendars',
  calendarItems: '/learn/api/v1/calendars/calendarItems',
  courseCalendarItems: '/learn/api/v1/courses/{courseId}/calendars/calendarItems',
  /** The Ultra "to-do" widget: overdue / due today / upcoming, in one call. */
  todoItems: '/learn/api/v1/calendars/todo/studentItems',

  // ── messages (conversations) ────────────────────────────────────────────
  conversations: '/learn/api/v1/courses/{courseId}/conversations',
  conversation: '/learn/api/v1/courses/{courseId}/conversations/{conversationId}',
  conversationMessages:
    '/learn/api/v1/courses/{courseId}/conversations/{conversationId}/messages',
  conversationParticipants:
    '/learn/api/v1/courses/{courseId}/conversations/{conversationId}/participants',
  messagesSummary: '/learn/api/v1/messages/summary',
  /** Unread conversation counts across every course, in one call. */
  conversationCounts: '/learn/api/v1/courses/conversations/counts',

  // ── discussions ─────────────────────────────────────────────────────────
  discussionSettings: '/learn/api/v1/courses/{courseId}/discussionboards/settings',
  discussionCount: '/learn/api/v1/courses/{courseId}/discussionboards/count',
  forumMessages:
    '/learn/api/v1/courses/{courseId}/discussionboards/default/forums/{forumId}/messages',
  forumMessageReplies:
    '/learn/api/v1/courses/{courseId}/discussionboards/default/forums/{forumId}/messages/{messageId}/replies',
  forumMessageStates:
    '/learn/api/v1/courses/{courseId}/discussionboards/default/forums/{forumId}/messages/{messageId}/states',
  forumCounts:
    '/learn/api/v1/courses/{courseId}/discussionboards/default/forums/{forumId}/counts',

  // ── attendance ──────────────────────────────────────────────────────────
  attendanceRecords: '/learn/api/v1/courses/{courseId}/attendanceRecords',
  attendanceGradebook: '/learn/api/v1/courses/{courseId}/attendance/gradebook',

  // ── activity stream ─────────────────────────────────────────────────────
  /** POST `{providers:{},forOverview:false,retrieveOnly:false,flushCache:false}`. */
  stream: '/learn/api/v1/streams/ultra',

  // ── Anthology Foundations services ──────────────────────────────────────
  /**
   * Tenant and person UUIDs plus the regional service routing table. Needed to
   * address any `/foundations/...` service, which are keyed by UUID rather than
   * by the `_12345_1`-style ids the rest of the API uses.
   */
  foundationsContext: '/learn/api/v1/foundationsToken/context',
  /**
   * Course badges/achievements. Addressed by Foundations UUIDs: `tenantId` from
   * `foundationsContext`, and the `foundationsId` fields on the course and
   * membership records returned by `selfMemberships`. `{regionStage}` is the
   * `eu.prod/prod` style prefix from the context response.
   */
  achievements:
    '/foundations/{regionStage}/lms-achievements/api/v1/tenants/{tenantId}/courses/{courseUuid}/achievements',
  myAchievements:
    '/foundations/{regionStage}/lms-achievements/api/v1/tenants/{tenantId}/courses/{courseUuid}/memberships/{membershipUuid}/achievements',
} as const;

export type OperationName = keyof typeof DEFAULT_ENDPOINTS;
export type EndpointMap = Record<OperationName, string>;

export interface EndpointProfile {
  version: 1;
  /** Only the operations that differ from the defaults. */
  overrides: Partial<EndpointMap>;
  source?: string;
  capturedAt?: string;
  /** Paths seen in a HAR that we do not model. Kept purely for inspection. */
  observed?: Array<{ method: string; path: string; count: number }>;
}

let cached: EndpointMap | null = null;

export function loadEndpoints(): EndpointMap {
  if (cached) return cached;
  const map: EndpointMap = { ...DEFAULT_ENDPOINTS };
  const file = profilePath();
  if (existsSync(file)) {
    try {
      const profile = JSON.parse(readFileSync(file, 'utf8')) as EndpointProfile;
      for (const [op, template] of Object.entries(profile.overrides ?? {})) {
        if (op in map && typeof template === 'string') {
          map[op as OperationName] = template;
          log.debug(`Endpoint override: ${op} -> ${template}`);
        }
      }
    } catch (err) {
      log.warn(`Ignoring unreadable endpoint profile at ${file}`, String(err));
    }
  }
  cached = map;
  return map;
}

export function saveProfile(profile: EndpointProfile): void {
  ensureDir(stateDir());
  writeFileSync(profilePath(), `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  cached = null;
}

export function expand(op: OperationName, params: Record<string, string> = {}): string {
  const template = loadEndpoints()[op];
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = params[key];
    if (value === undefined) {
      throw new Error(`Endpoint "${op}" needs a "${key}" parameter (template: ${template})`);
    }
    // Blackboard ids look like `_12345_1` and must survive verbatim; encodeURIComponent
    // leaves underscores and digits alone, so this is safe for them and still
    // protects against traversal in caller-supplied values.
    return encodeURIComponent(value);
  });
}
