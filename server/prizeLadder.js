// The core prize-ladder algorithm, used identically for the Main Event
// (unit = one Activated Stonk Broker, 733,332 STONK) and every satellite
// (unit = one Main Event ticket, 3,000 STONK). Same function, different unit
// cost — exactly matching "every satellite uses exactly the same prize
// algorithm" from the spec.
//
// Given a player pool (already net of rake) and a unit cost, funds as many
// whole units as the pool supports; whatever's left goes winner-take-all to
// the next finishing position.

function computeLadder(playerPool, unitCost) {
  const unitsFunded = Math.floor(playerPool / unitCost);
  const remainder = playerPool - unitsFunded * unitCost;
  return { unitsFunded, remainder: Math.round(remainder) };
}

module.exports = { computeLadder };
