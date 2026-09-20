/**
 * What the browser and the server have to agree about.
 *
 * The drawing is the order. If the page decided what a line meant and then
 * told the server what to trade, the page could say anything: a line drawn
 * flat and reported as a ten-leg long would be indistinguishable from an
 * honest one. So the page sends the points it drew and nothing else, and both
 * sides run this code to work out what they mean.
 *
 * Nothing here touches React, the DOM or a network. That is the condition for
 * living in both places at once.
 */

export * from "./shape";
export * from "./venue";
