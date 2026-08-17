import type { ConversationDto } from '@lumora/shared';

export interface ConversationGroup {
  label: string;
  items: ConversationDto[];
}

/**
 * Buckets threads by when they were last used.
 *
 * Lifted out of the old `ConversationList` when the history moved into the app
 * sidebar (docs/00-product.md FR-21) and that component went away. It lives in
 * its own module rather than inside the sidebar component because the buckets
 * are a product decision — docs/00-product.md §7 names them — and burying them
 * in one consumer is how a second consumer ends up with its own copy.
 *
 * Boundaries are calendar-relative, not elapsed-time: something from 11pm
 * yesterday belongs under "Yesterday" at 9am, not under "Today" because 10
 * hours have passed. Elapsed-time bucketing is the version of this that looks
 * right in a unit test and wrong to a person.
 */
export function groupByRecency(
  conversations: ConversationDto[],
  now = new Date(),
): ConversationGroup[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const startOfWeek = startOfToday - 7 * 24 * 60 * 60 * 1000;

  const buckets: ConversationGroup[] = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Previous 7 days', items: [] },
    { label: 'Earlier', items: [] },
  ];

  for (const conversation of conversations) {
    // A thread created but never used falls to `Earlier` rather than being
    // dropped — it is still in the list, and hiding it would be a bug the user
    // reports as "my conversation vanished".
    const at = conversation.lastMessageAt ?? conversation.createdAt;
    const time = new Date(at).getTime();

    if (time >= startOfToday) buckets[0]?.items.push(conversation);
    else if (time >= startOfYesterday) buckets[1]?.items.push(conversation);
    else if (time >= startOfWeek) buckets[2]?.items.push(conversation);
    else buckets[3]?.items.push(conversation);
  }

  return buckets.filter((bucket) => bucket.items.length > 0);
}
