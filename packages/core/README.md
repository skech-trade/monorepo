# core

What the browser and the server have to agree about.

The drawing is the order. If the page decided what a line meant and then told
the server what to trade, the page could say anything: a line drawn flat and
reported as a ten-leg long would be indistinguishable from an honest one. So
the page sends the points it drew and nothing else, and both sides run this
code to work out what they mean.

- `shape.ts` turns points into legs. Where the line turns is where the
  position flips.
- `venue.ts` is Lighter as it actually is: the size floors, the margin levels,
  the liquidation formula. One set of numbers, or the page promises a position
  the venue will not take.

Nothing here touches React, the DOM or a network. That is the condition for
living in both places at once.

## The zero-fee trap

`turnTol` had a floor of the fee round trip, and Lighter charges nothing, so
the floor was zero: every sample of a flat line cleared it and became a turn,
and a flat line came back as thirty-one legs. On screen that was invisible,
because a flat shape is rejected before its legs are read. On the venue it is
thirty-one reversals of a real position. The floor is two basis points now,
which is sixteen dollars on Bitcoin at eighty thousand, and a turn smaller
than that is a wobble whatever it costs to trade.
