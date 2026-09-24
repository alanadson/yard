/**
 * How the Busca keeps its rows between rebuilds: one cell per domain, each
 * rebuilt only when one of the inputs it reads moves.
 *
 * The list used to come out of one function over sixteen inputs, rebuilt
 * whole whenever any of them changed. While an agent writes, the file feed
 * moves every 250 ms and git status right behind it, and every one of up to
 * six thousand file rows came back as a new object with a new icon, only for
 * the agents, the canvas, the notes and the actions to be rebuilt identical
 * next to them. Kept per domain, a change costs the rows that read it.
 *
 * Nothing here knows what a row is: `Palette/index.tsx` declares the domains,
 * in the order the list has always had.
 */

export interface Domain<W, R> {
  /**
   * Everything the rows are made of, compared one by one (`Object.is`) with
   * what the previous compose saw: the same objects hand back the same rows.
   *
   * `null` for a domain whose rows read something the world does not carry
   * (a store read straight, the clock). Those are rebuilt on every compose,
   * which is exactly as fresh as they were when everything was.
   */
  inputs: ((world: W) => readonly unknown[]) | null;
  rows: (world: W) => R[];
}

/** One compose per rebuild of the list; the domains' rows, concatenated in order. */
export function createComposer<W, R>(domains: readonly Domain<W, R>[]): (world: W) => R[] {
  const seen: (readonly unknown[] | null)[] = domains.map(() => null);
  const kept: R[][] = domains.map(() => []);
  return (world) => {
    const out: R[] = [];
    domains.forEach((domain, i) => {
      const inputs = domain.inputs ? domain.inputs(world) : null;
      const last = seen[i];
      if (!inputs || !last || !sameInputs(inputs, last)) {
        kept[i] = domain.rows(world);
        seen[i] = inputs;
      }
      // A loop, not `push(...rows)`: six thousand arguments is a lot to spread.
      for (const row of kept[i]) out.push(row);
    });
    return out;
  };
}

function sameInputs(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}

/**
 * Rows handed back from one build to the next, for a domain whose inputs
 * move often but whose rows mostly do not: the file feed moves every 250 ms
 * during agent writes, and it touches one path of thousands.
 *
 * A build asks for each row by a key that names everything the row is made
 * of. A key the previous build also asked for gets the very same object back;
 * `settle` ends the build and lets go of whatever it did not ask for, so what
 * is held is only ever the rows of the last list.
 */
export class Reuse<T> {
  private last = new Map<string, T>();
  private next = new Map<string, T>();

  /** The row the previous build kept under `key`, carried into this one. */
  take(key: string): T | undefined {
    const row = this.last.get(key);
    if (row !== undefined) this.next.set(key, row);
    return row;
  }

  /** A row this build had to make, kept for the next one; returns it. */
  keep(key: string, row: T): T {
    this.next.set(key, row);
    return row;
  }

  /** Ends a build: the rows it did not ask for are let go. */
  settle(): void {
    this.last = this.next;
    this.next = new Map();
  }
}
