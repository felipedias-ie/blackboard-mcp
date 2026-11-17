import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { roleLabel } from '../dist/client/index.js';
import { viewGroups } from '../dist/lib/groups.js';
import type { BbGroup, BbGroupSet } from '../dist/client/types.js';

describe('roleLabel', () => {
  // On Ultra the course role carries a localisation key object, not a name. The
  // roster used to print it as "[object Object]".
  test('turns the Ultra localisation object into a readable role', () => {
    const student = {
      role: 'S',
      courseRole: { identifier: 'S', courseName: { languageKey: 'S.name', bundle: 'course_roles' } },
    };
    assert.equal(roleLabel(student), 'Student');
  });

  test('keeps a real display name when the tenant provides one', () => {
    assert.equal(roleLabel({ courseRole: { identifier: 'T', courseName: 'Lab assistant' } }), 'Lab assistant');
  });

  test('falls back to the role code, then to the code itself', () => {
    assert.equal(roleLabel({ role: 'P' }), 'Instructor');
    assert.equal(roleLabel({ courseRole: { identifier: 'CUSTOM' } }), 'CUSTOM');
    assert.equal(roleLabel({}), '');
  });
});

describe('viewGroups', () => {
  const sets: BbGroupSet[] = [{ id: 'set1', title: 'Group Assignment' }];
  const names = new Map([
    ['u1', 'Zoe Zed'],
    ['u2', 'Ana Alpha'],
    ['u3', 'Me Myself'],
  ]);
  const groups: BbGroup[] = [
    { id: 'g10', title: 'New Group 10', groupSetId: 'set1', studentCount: 0, maximumEnrollment: 6, memberships: [] },
    {
      id: 'g9',
      title: 'New Group 9',
      groupSetId: 'set1',
      studentCount: 3,
      maximumEnrollment: 3,
      memberships: [
        { userId: 'u1', groupId: 'g9' },
        { userId: 'u3', groupId: 'g9' },
        { userId: 'u2', groupId: 'g9' },
      ],
    },
    { id: 'g2', title: 'New Group 2', groupSetId: 'set1', studentCount: 2, maximumEnrollment: 6 },
  ];

  test('orders groups with numbers compared as numbers', () => {
    const titles = viewGroups(groups, sets, names, 'u3').map((g) => g.title);
    assert.deepEqual(titles, ['New Group 2', 'New Group 9', 'New Group 10']);
  });

  test('finds my group, names the members and sorts them by name', () => {
    const mine = viewGroups(groups, sets, names, 'u3').filter((g) => g.isMine);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.id, 'g9');
    assert.deepEqual(mine[0]!.members.map((m) => m.name), ['Ana Alpha', 'Me Myself', 'Zoe Zed']);
    assert.equal(mine[0]!.members.find((m) => m.isMe)?.userId, 'u3');
    assert.equal(mine[0]!.groupSetTitle, 'Group Assignment');
  });

  test('reports full, open and empty from the count and the cap', () => {
    const byId = Object.fromEntries(viewGroups(groups, sets, names).map((g) => [g.id, g.status]));
    assert.deepEqual(byId, { g9: 'full', g2: 'open', g10: 'empty' });
  });

  test('says when people are in a group but Blackboard gave no list of them', () => {
    const hidden = viewGroups(groups, sets, names).find((g) => g.id === 'g2')!;
    assert.equal(hidden.size, 2);
    assert.equal(hidden.membersKnown, false);
    assert.equal(hidden.isMine, false);
  });

  test('shows the id for a member who is not in the roster, and never marks anyone as me without an id', () => {
    const odd: BbGroup[] = [{ id: 'g', title: 'G', studentCount: 1, memberships: [{ userId: 'ghost' }] }];
    const [view] = viewGroups(odd, [], new Map());
    assert.equal(view!.members[0]!.name, 'ghost');
    assert.equal(view!.isMine, false);
  });

  test('treats a cap of zero as no cap', () => {
    const [view] = viewGroups([{ id: 'g', studentCount: 5, maximumEnrollment: 0 }], [], new Map());
    assert.equal(view!.capacity, undefined);
    assert.equal(view!.status, 'open');
  });
});
