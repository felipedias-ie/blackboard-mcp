import { Session } from '../auth/session.js';
import { loadConfigOrNull, type Config } from '../config.js';
import { HttpClient } from './http.js';
import { expand } from './endpoints.js';
import { notConfigured, BlackboardError, toBlackboardError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import type {
  Paged, BbUser, BbCourse, BbTerm, BbMembership, BbContent, BbAttachment,
  BbGradeColumn, BbGrade, BbAttempt, BbAttemptFile, BbAnnouncement,
  BbCalendarItem, BbTodoItem, BbTodoResponse, BbConversation,
  BbConversationMessage, BbForumMessage, BbAttendanceRecord, BbStreamResponse,
  BbFileDetail, BbGradeSchema,
} from './types.js';

export * from './types.js';
export { HttpClient } from './http.js';

export interface ListOptions {
  /** Max rows to return across all pages. Defaults to config.pageSize. */
  limit?: number;
  offset?: number;
}

/** One read in a `utilities/batch` fan-out. */
export interface BatchRequest {
  method: 'GET';
  /** Version-relative, e.g. `v1/courses/_12345_1/gradebook/columns?limit=100`. */
  relativeUrl: string;
}

export interface BatchResult<T = unknown> {
  status?: number;
  code?: number;
  body?: T;
}

/** True when a grade row shows the student handed work in for the column. */
export function gradeHasSubmission(g: BbGrade): boolean {
  return (
    Boolean(g.lastAttemptId) ||
    Boolean(g.firstAttemptId) ||
    g.submissionStatus?.status === 'NEEDS_GRADING'
  );
}

/**
 * Moves action-bucket items whose column has a recorded submission into the
 * `submitted` bucket. Pure, so it is unit-testable without a live session.
 */
export function rebucketSubmitted(
  items: BbTodoItem[],
  submittedColumns: ReadonlySet<string>,
): BbTodoItem[] {
  return items.map((i) =>
    (i._bucket === 'overdue' || i._bucket === 'dueToday') &&
    i.column?.id &&
    submittedColumns.has(i.column.id)
      ? { ...i, _bucket: 'submitted' as const }
      : i,
  );
}

export class BlackboardClient {
  private selfCache: BbUser | null = null;
  private courseNameCache = new Map<string, string>();

  constructor(
    readonly http: HttpClient,
    readonly config: Config,
  ) {}

  static async create(): Promise<BlackboardClient> {
    const config = loadConfigOrNull();
    if (!config) throw notConfigured();
    const session = await Session.load();
    if (session.baseUrl !== config.baseUrl) {
      throw new BlackboardError('NOT_AUTHENTICATED', 'Stored session belongs to a different instance.', {
        hint: `Session is for ${session.baseUrl} but config points at ${config.baseUrl}. Run \`blackboard-mcp auth login\` again.`,
      });
    }
    return new BlackboardClient(new HttpClient(session, config), config);
  }

  // ── pagination ──────────────────────────────────────────────────────────

  /**
   * Walks the `paging.nextPage` chain until `limit` rows are collected.
   *
   * The v1 API reports no-more-pages as an *empty string* rather than a missing
   * field, and caps `limit` server-side, so we always page rather than asking
   * for everything at once.
   */
  async paginate<T>(
    path: string,
    opts: ListOptions & { query?: Record<string, string | number | boolean | undefined> } = {},
  ): Promise<T[]> {
    const limit = opts.limit ?? this.config.pageSize;
    const out: T[] = [];
    let next: string | undefined = path;
    let query: Record<string, string | number | boolean | undefined> | undefined = {
      ...opts.query,
      limit: Math.min(limit, 100),
      offset: opts.offset ?? 0,
    };

    for (let guard = 0; next && out.length < limit && guard < 50; guard += 1) {
      const page: Paged<T> = await this.http.json<Paged<T>>({ path: next, query });
      const rows = page?.results ?? [];
      out.push(...rows);
      next = page?.paging?.nextPage || undefined;
      query = undefined; // nextPage already carries its own query string.
      if (rows.length === 0) break;
    }
    return out.slice(0, limit);
  }

  /** Total row count for a list endpoint, without fetching the rows. */
  async count(path: string, query?: Record<string, string | number | undefined>): Promise<number> {
    const page = await this.http.json<Paged<unknown>>({
      path,
      query: { ...query, limit: 1, includeCount: true },
    });
    return page?.paging?.count ?? page?.results?.length ?? 0;
  }

  /**
   * Fans out up to ~20 reads in a single round trip via `utilities/batch`.
   *
   * This is how the Ultra front end avoids N+1 storms, and it is the difference
   * between "list every deadline across 8 courses" taking one request or twenty.
   * `relativeUrl` is version-relative (`v1/...`), not absolute.
   */
  async batch<T = unknown>(requests: BatchRequest[]): Promise<Array<BatchResult<T>>> {
    if (requests.length === 0) return [];
    const CHUNK = 20;
    const out: Array<BatchResult<T>> = [];
    for (let i = 0; i < requests.length; i += CHUNK) {
      const slice = requests.slice(i, i + CHUNK);
      // The batch endpoint is a PUT but performs only the reads it is given, so
      // it must bypass the read-only write guard.
      const res = await this.http.json<Array<BatchResult<T>> | { results?: Array<BatchResult<T>> }>({
        method: 'PUT',
        path: expand('batch'),
        query: { xb: 0 },
        body: slice,
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        forceAllowWrite: true,
      });
      const rows = Array.isArray(res) ? res : (res?.results ?? []);
      out.push(...rows);
    }
    return out;
  }

  // ── session ─────────────────────────────────────────────────────────────

  /**
   * Seconds until the session expires; 0 or negative means already gone.
   *
   * Blackboard answers with `{timeBeforeTimeout, timeBeforeTimeoutToShowWarning}`
   * in **milliseconds**. A fresh session reads about 10,800,000 (three hours).
   * Other shapes are tolerated because this is an internal endpoint.
   */
  async sessionSecondsRemaining(): Promise<number> {
    const res = await this.http.json<
      number | { timeBeforeTimeout?: number; seconds?: number; value?: number }
    >({ path: expand('sessionTtl'), retries: 0, allowRefresh: false });

    if (typeof res === 'number') return res;
    if (typeof res?.timeBeforeTimeout === 'number') {
      return Math.round(res.timeBeforeTimeout / 1000);
    }
    return res?.seconds ?? res?.value ?? 0;
  }

  /** Extends the session without doing real work. */
  async keepAlive(): Promise<void> {
    await this.http.request({
      path: expand('sessionKeepAlive'),
      retries: 0,
      allowNotFound: true,
      allowRefresh: false,
    });
  }

  /**
   * Keeps the session alive for as long as the process runs.
   *
   * Two mechanisms, because they cover different failures:
   *
   *  - **Keep-alive** pings Blackboard's own endpoint, which resets the
   *    inactivity timer. A session that is merely idle never expires.
   *  - **Silent renewal** replays the institution's SSO chain, which recovers a
   *    session that expired anyway (laptop asleep, absolute-lifetime cap).
   *
   * The result is that a user signs in once and is not asked again for as long
   * as their identity-provider session lives. Typically weeks.
   *
   * Returns a stop function.
   */
  startSessionKeeper(opts: { intervalMs?: number; thresholdSeconds?: number } = {}): () => void {
    const interval = opts.intervalMs ?? 10 * 60_000;
    const threshold = opts.thresholdSeconds ?? 20 * 60;
    let stopped = false;

    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        const remaining = await this.sessionSecondsRemaining();
        if (remaining <= 0) {
          log.info('Session expired; attempting silent renewal');
          const ok = await this.http.tryRefresh();
          log.info(ok ? 'Session renewed' : 'Silent renewal unavailable. User must sign in again');
          return;
        }
        if (remaining < threshold) {
          log.debug(`Session has ${Math.round(remaining / 60)} min left; pinging keep-alive`);
          await this.keepAlive();
        }
      } catch (err) {
        // A failed probe is usually the session already being gone; let the
        // renewal path handle it rather than treating it as fatal.
        log.debug('Session keeper tick failed', (err as Error).message);
        await this.http.tryRefresh().catch(() => false);
      }
    };

    const timer = setInterval(() => void tick(), interval);
    // Never hold the event loop open on this alone.
    timer.unref?.();
    void tick();

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  // ── identity ────────────────────────────────────────────────────────────

  async whoami(): Promise<BbUser> {
    if (this.selfCache) return this.selfCache;
    const user = await this.http.json<BbUser>({
      path: expand('self'),
      query: { expand: 'systemRoles,insRoles' },
    });
    this.selfCache = user;
    this.http.session.user = {
      id: user.id,
      userName: user.userName,
      displayName: displayName(user),
    };
    await this.http.session.persist();
    return user;
  }

  async selfId(): Promise<string> {
    return (await this.whoami()).id;
  }

  async getUser(userId: string): Promise<BbUser> {
    return this.http.json<BbUser>({ path: expand('user', { userId }) });
  }

  // ── courses ─────────────────────────────────────────────────────────────

  /**
   * The user's course memberships, with each course expanded.
   *
   * `includeCount` plus a high limit is what the Ultra course list itself does;
   * course counts are small enough (tens) that one request is correct here.
   */
  async listCourses(
    opts: { userId?: string; includeHidden?: boolean; availableOnly?: boolean; organizations?: 'exclude' | 'only' | 'include' } = {},
  ): Promise<BbMembership[]> {
    const query = {
      expand: 'course.effectiveAvailability,course.permissions,courseRole',
      includeCount: true,
      limit: 10000,
    };

    // `/users/me/memberships` is the tidier path but is not present on every
    // Learn release, so fall back to the id-scoped form, which is.
    let page: Paged<BbMembership>;
    if (opts.userId) {
      page = await this.http.json<Paged<BbMembership>>({
        path: expand('userMemberships', { userId: opts.userId }),
        query,
      });
    } else {
      try {
        page = await this.http.json<Paged<BbMembership>>({
          path: expand('selfMemberships'),
          query,
          retries: 0,
        });
      } catch (err) {
        const code = err instanceof BlackboardError ? err.code : '';
        if (code !== 'NOT_FOUND' && code !== 'FORBIDDEN') throw err;
        log.debug('users/me/memberships unavailable; falling back to the id-scoped path');
        page = await this.http.json<Paged<BbMembership>>({
          path: expand('userMemberships', { userId: await this.selfId() }),
          query,
        });
      }
    }
    let rows = page?.results ?? [];

    for (const m of rows) {
      if (m.course?.id) {
        this.courseNameCache.set(m.course.id, courseLabel(m.course));
      }
    }

    if (!opts.includeHidden) rows = rows.filter((m) => !m.userHasHidden);
    if (opts.availableOnly) {
      rows = rows.filter((m) => m.isAvailable !== false && m.course?.isAvailable !== false);
    }
    const orgMode = opts.organizations ?? 'exclude';
    if (orgMode === 'exclude') rows = rows.filter((m) => !m.course?.isOrganization);
    if (orgMode === 'only') rows = rows.filter((m) => m.course?.isOrganization);

    return rows;
  }

  async getCourse(courseId: string): Promise<BbCourse> {
    const course = await this.http.json<BbCourse>({ path: expand('course', { courseId }) });
    this.courseNameCache.set(courseId, courseLabel(course));
    return course;
  }

  /** Best-effort human label for a course id, using whatever is already cached. */
  async courseName(courseId: string): Promise<string> {
    const cached = this.courseNameCache.get(courseId);
    if (cached) return cached;
    try {
      return courseLabel(await this.getCourse(courseId));
    } catch {
      return courseId;
    }
  }

  async listTerms(opts: ListOptions = {}): Promise<BbTerm[]> {
    return this.paginate<BbTerm>(expand('terms'), opts);
  }

  async listRoster(courseId: string, opts: ListOptions = {}): Promise<BbMembership[]> {
    return this.paginate<BbMembership>(expand('courseRoster', { courseId }), {
      ...opts,
      query: { expand: 'user,courseRole' },
    });
  }

  async listCourseGroups(courseId: string, opts: ListOptions = {}): Promise<unknown[]> {
    return this.paginate(expand('courseGroups', { courseId }), opts);
  }

  async listCourseTools(courseId: string): Promise<unknown[]> {
    return this.paginate(expand('courseTools', { courseId }), { limit: 100 });
  }

  // ── content ─────────────────────────────────────────────────────────────

  /** Top-level items of a course outline. */
  async listTopLevelContents(courseId: string, opts: ListOptions = {}): Promise<BbContent[]> {
    const rows = await this.paginate<BbContent>(expand('contentsRoot', { courseId }), {
      limit: opts.limit ?? 200,
      offset: opts.offset,
      query: {
        '@view': 'Summary',
        expand: 'assignedGroups,selfEnrollmentGroups.group,gradebookCategory',
        includeInActivityTracking: true,
      },
    });
    return rows.map((c) => ({ ...c, _courseId: courseId, _depth: 0 }));
  }

  /**
   * Items under the `INTERACTIVE` root: discussions, journals and other
   * participation activities, which Ultra deliberately keeps out of the course
   * outline. Absent on tenants with the feature disabled, hence the soft fail.
   */
  async listInteractiveContents(courseId: string, opts: ListOptions = {}): Promise<BbContent[]> {
    try {
      const rows = await this.paginate<BbContent>(expand('contentsInteractive', { courseId }), {
        limit: opts.limit ?? 100,
        query: { '@view': 'Summary' },
      });
      return rows.map((c) => ({ ...c, _courseId: courseId, _depth: 0 }));
    } catch (err) {
      log.debug(`No INTERACTIVE content for ${courseId}`, String(err));
      return [];
    }
  }

  async getContent(courseId: string, contentId: string): Promise<BbContent> {
    const c = await this.http.json<BbContent>({
      path: expand('content', { courseId, contentId }),
    });
    return { ...c, _courseId: courseId };
  }

  async listChildren(courseId: string, contentId: string, opts: ListOptions = {}): Promise<BbContent[]> {
    const rows = await this.paginate<BbContent>(
      expand('contentChildren', { courseId, contentId }),
      {
        limit: opts.limit ?? 200,
        offset: opts.offset,
        query: { '@view': 'Summary', expand: 'gradebookCategory' },
      },
    );
    return rows.map((c) => ({ ...c, _courseId: courseId }));
  }

  /**
   * Depth-first walk of a course's content tree.
   *
   * There is no reliable recursive-listing endpoint, so we walk it. Folders and
   * lessons are the only containers; `hasChildren` is absent on some tenants, so
   * we fall back to inspecting the handler's `contentDetail` for `isFolder`.
   */
  async walkContents(
    courseId: string,
    opts: { maxDepth?: number; maxNodes?: number; rootId?: string; includeInteractive?: boolean } = {},
  ): Promise<BbContent[]> {
    const maxDepth = opts.maxDepth ?? 6;
    const maxNodes = opts.maxNodes ?? 600;
    const out: BbContent[] = [];
    const seen = new Set<string>();

    const visit = async (nodes: BbContent[], depth: number, prefix: string): Promise<void> => {
      for (const node of nodes) {
        if (out.length >= maxNodes) return;
        if (seen.has(node.id)) continue; // Course links can create cycles.
        seen.add(node.id);

        const label = node.title ?? node.id;
        const path = prefix ? `${prefix} / ${label}` : label;
        out.push({ ...node, _courseId: courseId, _path: path, _depth: depth });

        if (isContainer(node) && depth < maxDepth) {
          try {
            const children = await this.listChildren(courseId, node.id, { limit: 200 });
            await visit(children, depth + 1, path);
          } catch (err) {
            // A single unreadable folder must not abort the whole walk.
            log.debug(`Skipping children of ${node.id}`, String(err));
          }
        }
      }
    };

    if (opts.rootId) {
      await visit(await this.listChildren(courseId, opts.rootId, { limit: 200 }), 0, '');
      return out;
    }

    await visit(await this.listTopLevelContents(courseId, { limit: 200 }), 0, '');

    // Discussions and journals hang off a separate root; include them unless
    // the caller explicitly narrowed to a subtree.
    if (opts.includeInteractive !== false) {
      const interactive = await this.listInteractiveContents(courseId, { limit: 100 });
      if (interactive.length > 0) await visit(interactive, 0, 'Discussions & activities');
    }
    return out;
  }

  async listAttachments(courseId: string, contentId: string): Promise<BbAttachment[]> {
    return this.paginate<BbAttachment>(
      expand('contentAttachments', { courseId, contentId }),
      { limit: 100 },
    );
  }

  /** Marks a reviewable content item as reviewed. Requires writes enabled. */
  async markReviewed(courseId: string, contentId: string, reviewed = true): Promise<void> {
    await this.http.request({
      method: 'PATCH',
      path: expand('contentState', { courseId, contentId }),
      body: { reviewed },
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    });
  }

  // ── gradebook ───────────────────────────────────────────────────────────

  async listGradeColumns(courseId: string, opts: ListOptions = {}): Promise<BbGradeColumn[]> {
    return this.paginate<BbGradeColumn>(expand('gradeColumns', { courseId }), {
      limit: opts.limit ?? 200,
      offset: opts.offset,
      query: {
        isExcludedFromCourseUserActivity: true,
        expand: 'associatedRubrics,collectExternalSubmissions',
        includeInvisible: false,
      },
    });
  }

  async getGradeColumn(courseId: string, columnId: string): Promise<BbGradeColumn> {
    return this.http.json<BbGradeColumn>({ path: expand('gradeColumn', { courseId, columnId }) });
  }

  /** The course's calculated final-grade column, when the tenant exposes one. */
  async getFinalGradeColumn(courseId: string): Promise<BbGradeColumn | null> {
    const res = await this.http.request({
      path: expand('finalGrade', { courseId }),
      allowNotFound: true,
      retries: 0,
    });
    if (res.status === 404) return null;
    return (await res.body.json()) as BbGradeColumn;
  }

  /**
   * Grades for one column. This is the reliable read: the course-wide
   * `gradebook/grades` list omits score fields on some tenants, whereas the
   * per-column endpoint returns `effectiveScore`/`displayGrade`/`status`.
   */
  async getColumnGrades(courseId: string, columnId: string, userId?: string): Promise<BbGrade[]> {
    const uid = userId ?? (await this.selfId());
    return this.paginate<BbGrade>(expand('columnGrades', { courseId, columnId }), {
      limit: 100,
      query: { userId: uid, expand: 'lastFeedbackAuthor,lastInstructorNotesAuthor' },
    });
  }

  /** Course-wide grade list for a user, with columns expanded. */
  async listGrades(courseId: string, userId?: string, opts: ListOptions = {}): Promise<BbGrade[]> {
    const uid = userId ?? (await this.selfId());
    return this.paginate<BbGrade>(expand('grades', { courseId }), {
      limit: opts.limit ?? 200,
      query: {
        userId: uid,
        expand: 'lastAttempt,attemptsLeft,submissionStatus,hasAttemptOrGradeFeedback,column',
        sort: 'column.position(asc)',
      },
    });
  }

  /** All grading schemas defined in a course. */
  async listGradeSchemas(courseId: string): Promise<BbGradeSchema[]> {
    return this.paginate<BbGradeSchema>(expand('gradeSchemas', { courseId }), { limit: 100 });
  }

  async getGradeSchema(courseId: string, schemaId: string): Promise<BbGradeSchema> {
    return this.http.json<BbGradeSchema>({ path: expand('gradeSchema', { courseId, schemaId }) });
  }

  /**
   * Due-date / time-limit exceptions granted to a student (extensions).
   *
   * Keyed by *membership* id, not user id. Take it from the course roster or
   * the membership record in `listCourses`.
   */
  async listDueDateExceptions(courseId: string, membershipId: string): Promise<unknown[]> {
    try {
      return await this.paginate(
        expand('gradebookExceptions', { courseId, membershipId }),
        { limit: 100 },
      );
    } catch (err) {
      log.debug(`No exceptions readable for ${courseId}/${membershipId}`, String(err));
      return [];
    }
  }

  async getAttempt(courseId: string, attemptId: string): Promise<BbAttempt> {
    return this.http.json<BbAttempt>({ path: expand('attempt', { courseId, attemptId }) });
  }

  async listColumnAttempts(courseId: string, columnId: string, opts: ListOptions = {}): Promise<BbAttempt[]> {
    return this.paginate<BbAttempt>(expand('columnAttempts', { courseId, columnId }), opts);
  }

  /** Files submitted with an attempt. */
  async listAttemptFiles(courseId: string, columnId: string, attemptId: string): Promise<BbAttemptFile[]> {
    return this.paginate<BbAttemptFile>(
      expand('attemptFiles', { courseId, columnId, attemptId }),
      { limit: 100 },
    );
  }

  attemptFileDownloadPath(courseId: string, columnId: string, attemptId: string, fileId: string): string {
    return expand('attemptFileDownload', { courseId, columnId, attemptId, fileId });
  }

  attachmentDownloadPath(courseId: string, contentId: string, attachmentId: string): string {
    return expand('contentAttachmentDownload', { courseId, contentId, attachmentId });
  }

  // ── announcements ───────────────────────────────────────────────────────

  async listCourseAnnouncements(courseId: string, opts: ListOptions = {}): Promise<BbAnnouncement[]> {
    const rows = await this.paginate<BbAnnouncement>(
      expand('courseAnnouncements', { courseId }),
      {
        limit: opts.limit ?? 25,
        offset: opts.offset,
        query: { sort: 'startDateRestriction(desc)' },
      },
    );
    const name = await this.courseName(courseId);
    return rows.map((a) => ({ ...a, courseId, _courseName: name }));
  }

  // ── calendar & deadlines ────────────────────────────────────────────────

  async listCalendarItems(opts: { since: string; until: string; courseId?: string } & ListOptions): Promise<BbCalendarItem[]> {
    const path = opts.courseId
      ? expand('courseCalendarItems', { courseId: opts.courseId })
      : expand('calendarItems');
    return this.paginate<BbCalendarItem>(path, {
      limit: opts.limit ?? 200,
      query: { since: opts.since, until: opts.until },
    });
  }

  /**
   * The Ultra to-do widget: overdue, due today, and upcoming in one call.
   * Buckets are flattened with `_bucket` set so callers can group them again.
   *
   * Two server quirks are handled here rather than by each caller:
   *  - the endpoint caps the `since`..`until` span (16 days on the tenants we
   *    have seen), so a wider request is split into legal chunks;
   *  - some tenants leave `overdueItems` empty (or list only still-actionable
   *    ones), so the calendar's gradebook due dates are merged in to give the
   *    full overdue picture.
   */
  async listTodo(opts: { since: string; until: string }): Promise<BbTodoItem[]> {
    const sinceMs = Date.parse(opts.since);
    const untilMs = Date.parse(opts.until);

    const [nativeRes, calRes] = await Promise.allSettled([
      this.nativeTodo(sinceMs, untilMs),
      this.todoFromCalendar(opts),
    ]);

    if (nativeRes.status === 'rejected' && calRes.status === 'rejected') {
      const err = nativeRes.reason;
      throw err instanceof BlackboardError ? err : toBlackboardError(err);
    }
    if (calRes.status === 'rejected') return nativeRes.status === 'fulfilled' ? nativeRes.value : [];
    if (nativeRes.status === 'rejected') {
      log.warn('To-do endpoint unavailable; using calendar items only');
      return calRes.value;
    }

    // Native rows win on conflict (they carry point values and the server's own
    // actionability rules); calendar rows fill in everything the endpoint omits.
    const key = (i: BbTodoItem): string => `${i.column?.id ?? i.title}|${i.dueDate}`;
    const merged = [...nativeRes.value];
    const seen = new Set(merged.map(key));
    for (const item of calRes.value) {
      if (seen.has(key(item))) continue;
      seen.add(key(item));
      merged.push(item);
    }
    return this.annotateSubmissions(merged);
  }

  /**
   * Splits past-due items that already carry a student submission out of the
   * overdue/due-today buckets into `submitted`.
   *
   * The to-do endpoint only reports due dates, so "overdue" conflates "not done"
   * with "done, not graded". The grade row's attempt ids are the authoritative
   * signal that work was handed in. One batch fan-out covers every affected
   * course; if it fails the buckets are left untouched.
   */
  private async annotateSubmissions(items: BbTodoItem[]): Promise<BbTodoItem[]> {
    const byCourse = new Map<string, BbTodoItem[]>();
    for (const i of items) {
      if (i._bucket !== 'overdue' && i._bucket !== 'dueToday') continue;
      const courseId = i._courseId ?? i.column?.courseId;
      if (!courseId || !i.column?.id) continue;
      const list = byCourse.get(courseId) ?? [];
      list.push(i);
      byCourse.set(courseId, list);
    }
    if (byCourse.size === 0) return items;

    let responses: Array<BatchResult<Paged<BbGrade>>> = [];
    try {
      const userId = await this.selfId();
      responses = await this.batch<Paged<BbGrade>>(
        [...byCourse.keys()].map((courseId) => ({
          method: 'GET' as const,
          relativeUrl: `v1/courses/${courseId}/gradebook/grades?userId=${userId}&limit=100&expand=column,submissionStatus`,
        })),
      );
    } catch (err) {
      log.warn('Could not check submission status; leaving to-do buckets as-is', String(err));
      return items;
    }

    const submitted = new Set<string>();
    responses.forEach((res, idx) => {
      const courseId = [...byCourse.keys()][idx];
      if (!courseId) return;
      const status = res.status ?? res.code ?? 200;
      if (status >= 400) return;
      for (const g of res.body?.results ?? []) {
        const columnId = g.columnId ?? g.column?.id;
        if (columnId && gradeHasSubmission(g)) submitted.add(columnId);
      }
    });

    return rebucketSubmitted(items, submitted);
  }

  /**
   * Calls the native to-do endpoint, splitting the range because Blackboard
   * rejects any request whose `since`..`until` span exceeds the server's cap.
   * Buckets are recomputed from each item's due date so chunked results merge
   * consistently.
   */
  private async nativeTodo(sinceMs: number, untilMs: number): Promise<BbTodoItem[]> {
    const MAX_SPAN_MS = 16 * 86_400_000;
    const seen = new Set<string>();
    const out: BbTodoItem[] = [];

    for (let start = sinceMs; start < untilMs; start += MAX_SPAN_MS) {
      const end = Math.min(start + MAX_SPAN_MS, untilMs);
      const res = await this.http.json<BbTodoResponse>({
        path: expand('todoItems'),
        query: { since: new Date(start).toISOString(), until: new Date(end).toISOString() },
      });
      const rows: Array<[BbTodoItem[] | undefined, BbTodoItem['_bucket']]> = [
        [res?.overdueItems, 'overdue'],
        [res?.dueTodayItems, 'dueToday'],
        [res?.futureDueItems, 'upcoming'],
      ];
      for (const [list, fallbackBucket] of rows) {
        for (const item of list ?? []) {
          const key = `${item.column?.id ?? item.title}|${item.dueDate}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            ...item,
            _bucket: item.dueDate ? this.todoBucket(item.dueDate) : fallbackBucket,
            _courseId: item.column?.courseId,
          });
        }
      }
    }
    return out;
  }

  /** Which to-do bucket a due date falls into, relative to the local day. */
  private todoBucket(dueDate: string, now = new Date()): BbTodoItem['_bucket'] {
    const due = Date.parse(dueDate);
    if (!Number.isFinite(due)) return 'upcoming';
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (due < startOfToday) return 'overdue';
    if (due < startOfToday + 86_400_000) return 'dueToday';
    return 'upcoming';
  }

  /**
   * Rebuilds the to-do buckets from the calendar API.
   *
   * Gradebook due dates surface as `GradableItem` calendar entries: the entry's
   * `itemSourceId` is the gradebook column id and `calendarId` is the course id,
   * so the result is interchangeable with the native to-do payload.
   */
  private async todoFromCalendar(opts: { since: string; until: string }): Promise<BbTodoItem[]> {
    const items = await this.listCalendarItems({ ...opts, limit: 400 });
    const seen = new Set<string>();
    const out: BbTodoItem[] = [];

    for (const i of items) {
      if (i.itemSourceType !== 'blackboard.platform.gradebook2.GradableItem') continue;
      const due = i.endDate ?? i.startDate;
      if (!due) continue;
      const key = `${i.itemSourceId ?? i.id ?? i.title}|${due}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        title: i.title,
        dueDate: due,
        _bucket: this.todoBucket(due),
        _courseId: i.calendarId,
        column: i.itemSourceId
          ? ({ id: i.itemSourceId, courseId: i.calendarId, name: i.title } as unknown as BbGradeColumn)
          : undefined,
      });
    }
    return out;
  }

  // ── messages ────────────────────────────────────────────────────────────

  async listConversations(courseId: string, opts: ListOptions = {}): Promise<BbConversation[]> {
    return this.paginate<BbConversation>(expand('conversations', { courseId }), opts);
  }

  async listConversationMessages(courseId: string, conversationId: string, opts: ListOptions = {}): Promise<BbConversationMessage[]> {
    return this.paginate<BbConversationMessage>(
      expand('conversationMessages', { courseId, conversationId }),
      opts,
    );
  }

  /** Unread conversation counts for every course at once. */
  async conversationCounts(): Promise<unknown> {
    return this.http.json({ path: expand('conversationCounts') });
  }

  async messagesSummary(): Promise<unknown> {
    return this.http.json({ path: expand('messagesSummary') });
  }

  // ── discussions ─────────────────────────────────────────────────────────

  async listForumMessages(courseId: string, forumId: string, opts: ListOptions = {}): Promise<BbForumMessage[]> {
    return this.paginate<BbForumMessage>(expand('forumMessages', { courseId, forumId }), opts);
  }

  async listForumReplies(courseId: string, forumId: string, messageId: string, opts: ListOptions = {}): Promise<BbForumMessage[]> {
    return this.paginate<BbForumMessage>(
      expand('forumMessageReplies', { courseId, forumId, messageId }),
      opts,
    );
  }

  // ── attendance ──────────────────────────────────────────────────────────

  async listAttendance(courseId: string, opts: ListOptions = {}): Promise<BbAttendanceRecord[]> {
    return this.paginate<BbAttendanceRecord>(expand('attendanceRecords', { courseId }), opts);
  }

  // ── activity stream ─────────────────────────────────────────────────────

  async getStream(opts: { forOverview?: boolean; flushCache?: boolean } = {}): Promise<BbStreamResponse> {
    return this.http.json<BbStreamResponse>({
      method: 'POST',
      path: expand('stream'),
      body: {
        providers: {},
        forOverview: opts.forOverview ?? false,
        retrieveOnly: true,
        flushCache: opts.flushCache ?? false,
      },
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      forceAllowWrite: true, // A POST that only reads the stream.
    });
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

export function displayName(user: BbUser): string {
  const preferred = user.preferredDisplayName?.trim();

  // Some tenants ship the display-name *template* rather than a rendered value,
  // so this field arrives as the literal token "GIVEN_NAME". Treat an all-caps
  // underscore token as unset; a real name is never shaped like that, and the
  // given/family fields are populated in exactly these cases.
  const isUnresolvedTemplate = !!preferred && /^[A-Z][A-Z_]*$/.test(preferred);

  if (preferred && !isUnresolvedTemplate) return preferred;

  const parts = [user.givenName, user.familyName].filter(Boolean);
  if (parts.length) return parts.join(' ');
  return preferred ?? user.userName ?? user.id;
}

export function courseLabel(course: BbCourse | undefined): string {
  if (!course) return 'Unknown course';
  return course.displayName ?? course.name ?? course.courseId ?? course.id;
}

/** Handlers whose `contentDetail` marks them as containers of other items. */
export function isContainer(node: BbContent): boolean {
  if (node.hasChildren === true) return true;
  if (node.hasChildren === false) return false;
  const detail = node.contentHandler ? node.contentDetail?.[node.contentHandler] : undefined;
  if (detail && (detail.isFolder === true || detail.isLesson === true)) return true;
  return (
    node.contentHandler === 'resource/x-bb-folder' ||
    node.contentHandler === 'resource/x-bb-lesson'
  );
}

/** Pulls the file record out of a `resource/x-bb-file` content item. */
export function fileDetailOf(node: BbContent): BbFileDetail | null {
  const detail = node.contentHandler ? node.contentDetail?.[node.contentHandler] : undefined;
  const file = detail?.file as BbFileDetail | undefined;
  return file ?? null;
}
