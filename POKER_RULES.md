# Texas Hold'em Betting Rules (2-Player Heads-Up)

## Overview
In heads-up (2-player) Texas Hold'em, the dealer button player posts the small blind and acts LAST on all streets EXCEPT preflop.

## Positions
- **Button/Dealer** = Small Blind (SB)
- **Other Player** = Big Blind (BB)

## Pre-Flop Betting
1. **SB posts** small blind (e.g., 0.10)
2. **BB posts** big blind (e.g., 0.25)
3. **SB acts FIRST** (needs to call 0.15 more, raise, or fold)
4. **BB acts SECOND** (can check if SB called, or call/raise if SB raised)
5. **Betting continues** until both players have either:
   - Put in equal amounts, OR
   - One player folds

### Preflop Scenarios:

**Scenario A: SB calls**
- SB: calls 0.15 more → total 0.25
- BB: can check (already at 0.25) OR raise
- If BB checks → **FLOP**
- If BB raises → SB must call/raise/fold

**Scenario B: SB raises to 0.50**
- SB: raises to 0.50 → total 0.50
- BB: must call (0.25 more), re-raise, or fold
- If BB calls → **FLOP**
- If BB raises → SB must call/raise/fold

**Scenario C: SB folds**
- BB wins the pot immediately

## Post-Flop Betting (Flop, Turn, River)
After the flop is dealt:
1. **BB acts FIRST** (button acts last on all post-flop streets)
2. **SB acts SECOND**
3. Betting continues until both players check or match bets

### Post-Flop Scenarios:

**Scenario A: Both check**
- BB: checks
- SB: checks
- **Next street** (Turn/River) or **Showdown**

**Scenario B: BB bets**
- BB: bets 0.50
- SB: must call, raise, or fold
- If SB calls → **Next street**
- If SB raises → BB must call/raise/fold

## Betting Round Completion Rules

A betting round is complete when:
1. **All players have acted**, AND
2. **All active players have equal money in the pot**, OR
3. **Only one player remains** (others folded), OR
4. **All players are all-in**

## Key Points for 2-Player
- **SB acts first preflop** (disadvantage)
- **BB acts first post-flop** (disadvantage)
- **Action alternates** back-and-forth until bets are matched
- **No one can "check" if there's an unmatched bet**

## Example Hand Flow

### Preflop:
1. SB posts 0.10, BB posts 0.25
2. **SB to act**: calls 0.15 → pot = 0.50
3. **BB to act**: checks → **FLOP DEALT**

### Flop (A♠ K♥ 7♦):
4. **BB to act**: bets 0.50 → pot = 1.00
5. **SB to act**: calls 0.50 → pot = 1.50, **TURN DEALT**

### Turn (A♠ K♥ 7♦ 3♣):
6. **BB to act**: checks
7. **SB to act**: bets 1.00 → pot = 2.50
8. **BB to act**: calls 1.00 → pot = 3.50, **RIVER DEALT**

### River (A♠ K♥ 7♦ 3♣ 9♠):
9. **BB to act**: checks
10. **SB to act**: checks → **SHOWDOWN**

## Implementation Checklist

- [ ] Track blind amounts separately (don't count as "actions")
- [ ] Preflop: SB acts first
- [ ] Post-flop: BB acts first
- [ ] Betting complete when: all acted + bets equal
- [ ] Allow "check" only when no unmatched bet
- [ ] Advance street when betting complete
- [ ] Showdown when all 5 community cards dealt + betting complete
