// Minimal ambient declaration so our differential test can use
// pokersolver from TypeScript without pulling in a full @types package.
// pokersolver ships no types and is used only in tests/diff/.
declare module 'pokersolver' {
  export class Hand {
    name: string;
    rank: number;
    cards: any[];
    descr: string;
    static solve(cards: string[]): Hand;
    static winners(hands: Hand[]): Hand[];
  }
}
