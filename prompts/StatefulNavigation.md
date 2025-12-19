# Stateful Navigation

When going back to a previous list, the cursor should be placed at the last
position such that users know where they left off.

After member/candidate actions, such as promotion, demotion, or eviction, the
current navigation list should be updated to reflect the new entity state. For
example, after demotion the list should change to a candidate view but still
showing the same persona, and the list item should change from demote to promote
to reflect the new state.
