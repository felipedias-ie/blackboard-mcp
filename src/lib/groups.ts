import type { BbGroup, BbGroupSet } from '../client/types.js';

export interface GroupMemberView {
  userId: string;
  name: string;
  isMe: boolean;
}

export interface GroupView {
  id: string;
  title: string;
  groupSetId?: string;
  groupSetTitle?: string;
  /** People in the group, from Blackboard's own count when it gives one. */
  size: number;
  /** Maximum members, when the group set caps it. */
  capacity?: number;
  status: 'empty' | 'open' | 'full';
  isMine: boolean;
  /** False when Blackboard reported people in the group but returned no list of them. */
  membersKnown: boolean;
  members: GroupMemberView[];
}

/**
 * Joins groups with their group set and with the names of the people in them.
 *
 * Pure, so it can be tested without a live session. `names` maps a user id to a
 * display name (build it from the roster); an id with no name is shown as the id.
 * Groups are ordered by set, then by title with numbers compared as numbers, so
 * "New Group 2" comes before "New Group 10".
 */
export function viewGroups(
  groups: BbGroup[],
  sets: BbGroupSet[],
  names: ReadonlyMap<string, string>,
  myId?: string,
): GroupView[] {
  const setTitles = new Map(sets.map((s) => [s.id, s.title ?? s.signUpSheet?.name]));

  return groups
    .map((g): GroupView => {
      const members = (g.memberships ?? [])
        .map((m) => ({
          userId: m.userId,
          name: names.get(m.userId) ?? m.userId,
          isMe: m.userId === myId,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const size = g.studentCount ?? members.length;
      const capacity = g.maximumEnrollment && g.maximumEnrollment > 0 ? g.maximumEnrollment : undefined;

      return {
        id: g.id,
        title: g.title ?? g.id,
        groupSetId: g.groupSetId,
        groupSetTitle: g.groupSetId ? setTitles.get(g.groupSetId) : undefined,
        size,
        capacity,
        status: size === 0 ? 'empty' : capacity !== undefined && size >= capacity ? 'full' : 'open',
        isMine: members.some((m) => m.isMe),
        membersKnown: g.memberships !== undefined || size === 0,
        members,
      };
    })
    .sort(
      (a, b) =>
        (a.groupSetTitle ?? '').localeCompare(b.groupSetTitle ?? '') ||
        a.title.localeCompare(b.title, undefined, { numeric: true }),
    );
}
