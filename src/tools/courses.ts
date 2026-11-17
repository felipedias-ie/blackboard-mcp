import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClient, guard, text, table, when, clip, section } from './helpers.js';
import { displayName, courseLabel, roleLabel, type BbMembership } from '../client/index.js';
import { viewGroups } from '../lib/groups.js';
import { Session } from '../auth/session.js';
import { loadConfigOrNull } from '../config.js';

export function registerCourseTools(server: McpServer): void {
  // ── identity & session ──────────────────────────────────────────────────

  server.registerTool(
    'bb_whoami',
    {
      title: 'Who am I on Blackboard',
      description:
        'Returns the signed-in Blackboard user (name, username, student id, email, institution roles) and the configured instance. Use this to confirm authentication is working before other calls.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_whoami', async () => {
      const client = await getClient();
      const me = await client.whoami();
      return text(
        [
          `**${displayName(me)}** on ${client.config.label ?? client.config.baseUrl}`,
          '',
          table([
            { field: 'user id', value: me.id },
            { field: 'username', value: me.userName },
            { field: 'student id', value: me.studentId },
            { field: 'email', value: me.emailAddress },
            { field: 'department', value: me.department },
            { field: 'system role', value: me.systemRole },
            { field: 'institution roles', value: (me.insRoles ?? []).join(', ') },
            { field: 'locale', value: me.locale },
          ]),
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'bb_session_status',
    {
      title: 'Blackboard session status',
      description:
        'Reports how much longer the stored Blackboard session is valid, when it was captured, and which cookies it holds. Call this when other tools start failing with session errors.',
      inputSchema: {
        keepAlive: z
          .boolean()
          .optional()
          .describe('Also ping the keep-alive endpoint to extend the session.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_session_status', async ({ keepAlive }) => {
      const config = loadConfigOrNull();
      const session = await Session.tryLoad();
      if (!config || !session) {
        return text(
          'No Blackboard session stored.\n\nRun `blackboard-mcp auth login` in a terminal to sign in.',
        );
      }
      const rows: Array<Record<string, string | number | undefined>> = [
        { field: 'instance', value: session.baseUrl },
        { field: 'captured', value: `${when(session.capturedAt.toISOString())} (${session.ageHours.toFixed(1)}h ago)` },
        { field: 'cookies', value: (await session.cookieNames()).join(', ') },
        { field: 'xsrf token', value: session.xsrfToken ? 'present' : 'absent' },
        { field: 'writes', value: config.allowWrites ? 'enabled' : 'disabled (read-only)' },
      ];

      let live = '';
      try {
        const client = await getClient();
        if (keepAlive) await client.keepAlive();
        const secs = await client.sessionSecondsRemaining();
        rows.push({
          field: 'expires in',
          value: secs > 0 ? `${Math.round(secs / 60)} min` : 'expired',
        });
        live = secs > 0 ? 'Session is **live**.' : 'Session has **expired**. Run `blackboard-mcp auth login`.';
      } catch (err) {
        live = `Could not reach Blackboard to verify: ${(err as Error).message}`;
      }

      return text(`${live}\n\n${table(rows)}`);
    }),
  );

  // ── courses ─────────────────────────────────────────────────────────────

  server.registerTool(
    'bb_list_courses',
    {
      title: 'List my Blackboard courses',
      description:
        'Lists the courses the signed-in user is enrolled in, with course id, name, term, role and last-access date. The returned `courseId` (like `_12345_1`) is what every other course tool needs. Start here.',
      inputSchema: {
        availableOnly: z
          .boolean()
          .optional()
          .describe('Only courses currently open to the student. Default false (show all).'),
        includeHidden: z
          .boolean()
          .optional()
          .describe('Include courses the user hid from their own course list. Default false.'),
        organizations: z
          .enum(['exclude', 'only', 'include'])
          .optional()
          .describe('Organizations/communities are excluded by default; "only" or "include" to change that.'),
        term: z.string().optional().describe('Case-insensitive substring filter on the term name.'),
        search: z.string().optional().describe('Case-insensitive substring filter on course name or code.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_list_courses', async (args) => {
      const client = await getClient();
      let rows = await client.listCourses({
        availableOnly: args.availableOnly,
        includeHidden: args.includeHidden,
        organizations: args.organizations,
      });

      if (args.term) {
        const needle = args.term.toLowerCase();
        rows = rows.filter((m) => (m.course?.term?.name ?? '').toLowerCase().includes(needle));
      }
      if (args.search) {
        const needle = args.search.toLowerCase();
        rows = rows.filter((m) =>
          `${courseLabel(m.course)} ${m.course?.courseId ?? ''}`.toLowerCase().includes(needle),
        );
      }

      // Most recently accessed first: that is nearly always what is wanted.
      rows.sort((a, b) => (b.lastAccessDate ?? '').localeCompare(a.lastAccessDate ?? ''));

      const body = table(
        rows.map((m) => ({
          courseId: m.course?.id ?? m.courseId,
          name: clip(courseLabel(m.course), 60),
          code: m.course?.displayId ?? m.course?.courseId,
          term: m.course?.term?.name,
          role: roleLabel(m),
          available: m.course?.isAvailable === false ? 'no' : 'yes',
          lastAccess: when(m.lastAccessDate),
        })),
      );

      return text(`${rows.length} course(s).\n\n${body}`);
    }),
  );

  server.registerTool(
    'bb_get_course',
    {
      title: 'Get Blackboard course details',
      description:
        'Full detail for one course: name, code, term, availability window, Ultra/Classic mode, and the tools enabled in it.',
      inputSchema: {
        courseId: z.string().describe('Course id from bb_list_courses, e.g. "_12345_1".'),
        includeTools: z.boolean().optional().describe('Also list the course tools. Default true.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_get_course', async ({ courseId, includeTools }) => {
      const client = await getClient();
      const course = await client.getCourse(courseId);

      const head = table([
        { field: 'name', value: courseLabel(course) },
        { field: 'course id', value: course.id },
        { field: 'code', value: course.courseId },
        { field: 'term', value: course.term?.name ?? course.termId },
        { field: 'available', value: course.isAvailable === false ? 'no' : 'yes' },
        { field: 'closed', value: course.isClosed ? 'yes' : 'no' },
        { field: 'organization', value: course.isOrganization ? 'yes' : 'no' },
        { field: 'mode', value: course.ultraStatus },
        { field: 'created', value: when(course.createdDate) },
        { field: 'modified', value: when(course.modifiedDate) },
      ]);

      let tools = '';
      if (includeTools !== false) {
        try {
          const list = (await client.listCourseTools(courseId)) as Array<Record<string, unknown>>;
          tools = table(
            list.slice(0, 60).map((t) => ({
              tool: String(t.title ?? t.name ?? t.id ?? ''),
              available: t.isAvailable === false ? 'no' : 'yes',
            })),
          );
        } catch {
          tools = '_Course tools unavailable for this course._';
        }
      }

      const desc = course.description ? clip(course.description, 800) : '';

      return text(
        `# ${courseLabel(course)}\n\n${head}${section('Description', desc)}${section('Tools', tools)}`,
      );
    }),
  );

  server.registerTool(
    'bb_list_terms',
    {
      title: 'List Blackboard terms',
      description: 'Lists academic terms defined on the instance, with their date ranges.',
      inputSchema: { limit: z.number().int().min(1).max(200).optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_list_terms', async ({ limit }) => {
      const client = await getClient();
      const terms = await client.listTerms({ limit: limit ?? 100 });
      return text(
        table(
          terms.map((t) => ({
            id: t.id,
            name: t.name,
            available: t.isAvailable === false ? 'no' : 'yes',
            start: when(t.startDate ?? undefined),
            end: when(t.endDate ?? undefined),
          })),
        ),
      );
    }),
  );

  server.registerTool(
    'bb_list_roster',
    {
      title: 'List course participants',
      description:
        'Lists the people enrolled in a course with their roles. Useful for finding an instructor to contact. Pass `groupId` (from bb_list_groups) to list only the members of one group; bb_list_groups itself shows every group with its members.',
      inputSchema: {
        courseId: z.string().describe('Course id, e.g. "_12345_1".'),
        role: z
          .enum(['all', 'instructors', 'students'])
          .optional()
          .describe('Filter by role bucket. Default "all".'),
        groupId: z
          .string()
          .optional()
          .describe('Only the members of this group, e.g. "_249588_1" from bb_list_groups.'),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_list_roster', async ({ courseId, role, groupId, limit }) => {
      const client = await getClient();
      let rows = await client.listRoster(courseId, { limit: limit ?? 200, groupId });

      if (role === 'instructors') {
        rows = rows.filter((m) => m.courseRole?.isActAsInstructor === true || m.role === 'P');
      } else if (role === 'students') {
        rows = rows.filter((m) => m.role === 'S');
      }

      return text(
        `${rows.length} participant(s).\n\n${table(
          rows.map((m) => ({
            name: m.user ? displayName(m.user) : m.userId,
            role: roleLabel(m),
            email: m.user?.emailAddress,
            userId: m.userId,
          })),
        )}`,
      );
    }),
  );

  server.registerTool(
    'bb_list_groups',
    {
      title: 'List course groups and their members',
      description:
        'Lists a course\'s group sets (sign-up sheets) and groups: capacity, sign-up window, and who is in each group. Pass `mine: true` to find the group the signed-in user belongs to, which is how to see the team members for a group assignment. Works for students: it reads the member list the Ultra sign-up page itself shows.',
      inputSchema: {
        courseId: z.string().describe('Course id, e.g. "_12345_1".'),
        mine: z.boolean().optional().describe('Only the group(s) the signed-in user is in.'),
        members: z.boolean().optional().describe('Include who is in each group. Default true.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_list_groups', async ({ courseId, mine, members }) => {
      const client = await getClient();
      const withMembers = members !== false;
      const [label, sets, groups, roster, me] = await Promise.all([
        client.courseName(courseId),
        client.listGroupSets(courseId),
        client.listGroups(courseId, { members: withMembers }),
        withMembers ? client.listRoster(courseId, { limit: 500 }) : Promise.resolve([] as BbMembership[]),
        client.whoami(),
      ]);

      const names = new Map(roster.map((m) => [m.userId, m.user ? displayName(m.user) : m.userId]));
      let views = viewGroups(groups, sets, names, me.id);
      if (mine) views = views.filter((g) => g.isMine);
      if (views.length === 0) {
        return text(mine ? `You are not in any group in ${label}.` : `${label} has no groups.`);
      }

      const setRows = sets.map((s) => ({
        'group set': s.title ?? s.signUpSheet?.name,
        groups: s.groupCount,
        students: s.studentCount,
        'max per group': s.maximumEnrollment || undefined,
        'sign-up opens': when(s.signUpSheet?.enrollmentStartDate),
        'sign-up closes': when(s.signUpSheet?.enrollmentEndDate),
        'can switch': s.signUpSheet?.allowMembersToChangeGroups === undefined
          ? undefined
          : s.signUpSheet.allowMembersToChangeGroups ? 'yes' : 'no',
      }));

      const person = (m: { name: string; isMe: boolean }): string => (m.isMe ? `${m.name} (you)` : m.name);
      const rows = views.map((g) => ({
        group: g.isMine ? `${g.title} (you)` : g.title,
        ...(sets.length > 1 ? { set: g.groupSetTitle } : {}),
        members: g.capacity ? `${g.size}/${g.capacity}` : g.size,
        status: g.status,
        people: !withMembers
          ? undefined
          : g.membersKnown
            ? g.members.map(person).join('; ')
            : '(member list not visible)',
        groupId: g.id,
      }));

      const own = views.find((g) => g.isMine);
      const ownTable = own
        ? `\n\n## ${own.title}: your team\n\n${table(own.members.map((m) => ({ name: person(m), userId: m.userId })))}`
        : '';

      return text(
        [
          `# Groups in ${label}`,
          '',
          sets.length ? `${table(setRows)}\n` : '',
          table(rows),
          own
            ? `\nYou are in **${own.title}** (${own.capacity ? `${own.size}/${own.capacity}` : own.size} member(s)).`
            : '\nYou are not in any of these groups.',
          ownTable,
        ].join('\n'),
      );
    }),
  );
}
