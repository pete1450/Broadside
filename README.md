# BROADSIDE

A slow-paced naval combat strategy game. Command a small squadron of
sailing warships, outmaneuver the enemy fleet, and capture their harbor.

## Objective

Sail north and **anchor inside the harbor capture zone for 60 seconds**
to take the fort and win. Lose all your ships and the battle is lost.
There are no reinforcements — every hull is irreplaceable.

## Your fleet

| Ship | HP | Guns | Speed | Gun range | Vision | Reload |
|---|---|---|---|---|---|---|
| Sloop | 80 | 2 | 28 | 58 | 100 | 8s |
| Frigate | 180 | 6 | 11 | 70 | 80 | 10s |
| Ship of the line | 350 | 10 | 8 | 82 | 65 | 12s |

The enemy defends with 1 ship of the line, 2 frigates, 1 sloop, and
2 shore batteries (220 HP, 30 damage per shot, range 98).

Sloops are scouts and skirmishers — the fastest thing afloat, but a
frigate broadside can gut one. Frigates are your workhorses. The ship
of the line is a floating fortress: slow, half-blind, and devastating
abeam.

## Controls

- **Tap a ship** — select it. Tap one of your grouped ships to select
  its whole group.
- **Tap water / an enemy** — with an order armed (below), that's the
  destination / target.
- **Drag** — pan the camera. **Pinch / wheel** — zoom.
- **Long-press a grouped ship** — pull it out of its group and select
  it alone.

Bottom bar orders: **Move**, **Attack**, **Patrol**, **Hold**,
**Anchor**, **Group**, **Guns: Free/Hold**, **Shot** type.

- **Move** — sail to a point, weapons free along the way.
- **Attack** — close with a target and hold your broadside on it.
- **Patrol** — tap two or more points; the ship loops between them.
- **Anchor** — drop anchor (takes effect immediately; weighing anchor
  to get moving again takes 5 seconds — don't anchor with enemies near).
- **Group** — assign the selection to control group 1–5. The whole
  group is selected immediately.
- **Guns: Hold** — never fire. **Guns: Free** — fire per your patience
  setting.

## Gunnery

Guns fire **only directly abeam** — within a few degrees of exactly
perpendicular to your hull. There is no bow or stern chaser: if you
want to shoot something, show it your broadside.

- **Patience slider (0–100%)** — your gunnery doctrine. Below 50% your
  crews fire early: faster shooting, lighter hits. Above 50% they hold
  their fire after loading for harder hits. At 100%, broadsides take
  1.5× as long and hit 1.5× as hard. Overall damage-per-second is flat —
  patience trades *rate* for *weight*.
- **Readiness bar** — the vertical bar floating by each of your ships.
  It climbs from zero (yellow) to your patience level and turns full
  green there: green means loaded, and the broadside fires the instant
  a target crosses the beam. Both the readiness bar and the hull bar above
  every damaged ship are always visible, fixed-size, and face the camera.
- **Shot type** — Round shot (full hull damage, full range), Chain
  (×0.8 range, shreds rigging, weak vs hull), Grape (×0.55 range,
  scythes the crew, weak vs hull). Applies to the whole selection.

Damage model — every ship tracks three pools:

- **Hull** — at zero, she sinks.
- **Rigging** — shot away, your ship slows (down to 35% speed) and
  turns worse.
- **Crew** — casualties slow your reloads (up to +80%) and spoil your
  aim (up to −35%).

Geometry matters. Raking a ship across the stern multiplies hit chance
and damage; firing into the bow does half. And the squarer your own
broadside is to the target — dead perpendicular — the harder every gun
hits, up to ×1.5. A perfectly timed broadside-to-broadside exchange is
the hardest-hitting geometry in the game.

## Wind and sailing

The compass shows the prevailing wind. Your ships sail fastest with the
wind abeam or astern, slower close-hauled, and **cannot sail within
about 30° of dead upwind** — ordered upwind, they tack automatically in
zigzags, which is slow. Turning needs way on: a ship dead in the water
turns sluggishly, a ship with speed carves. Plan your approaches with
the wind, not against it — beating upwind into the enemy's teeth is a
long, bloody business.

Land bends the local wind: it runs parallel to coasts and weakens in
the lee of islands.

## Fog of war

You see only what your ships see (and farther once explored). The
enemy is invisible until a ship's vision touches it — sloops, with
their 100-unit vision and 28 speed, are your eyes. Shore batteries
stay on the chart once found.

## Repairs

Anchor somewhere the enemy can't see for 3 seconds and your crews
start working: hull, rigging, and crew all recover at 3.375% per second.
Weighing anchor or being spotted stops it. The enemy gets no such
luxury — damage you deal sticks; red ships fight on until they sink.

## The enemy

The red squadron defends its harbor, not yours. Individual captains
vary: bold ones press and fire fast, cautious ones hold back and wait
for the heavy shot. They'll try to keep their broadsides on you, picking
chain against runners and grape up close. Most fight to the death — but a ship reduced below 10% hull may
break and run for the harbor instead (cautious captains run, hotheads
don't). A routed ship is out of the fight, not mending: damage sticks.
They sail, see, and shoot under exactly the same rules you do; only
repairs are yours alone.

## Tips

- Cross the T: a stern rake at dead perpendicular with patient gunners
  is the single most damaging thing you can do.
- Don't trade broadsides bow-to-bow — you'll lose half your damage
  into their stem.
- Chain a fleeing ship's rigging, then close with grape before
  boarding range... there is no boarding. Just sink her.
- Your sloops can't fight anything bigger than themselves. Use them to
  find things, bait batteries into revealing themselves, and run down
  cripples.
- Anchor to repair *before* you're at 30% — a ship that can't turn
  can't escape.

---

Debug: `?noenemy` loads a quiet ocean with five ships and no enemies,
for practicing maneuvers. The 🌬️ button overlays the local wind field
and every ship's effective gun range.
