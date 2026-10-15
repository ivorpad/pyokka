// statement names for the execution graph come from the runtime's AST (walk.names)
interface Item { name: string; price: number }

/* a block comment; `#` is not a comment in JS */
function total(items: Item[], rate: number): number {
  let sum = 0;
  for (const { price } of items) {
    sum += price;
  }
  const tax = sum * rate; // tax
  if (tax > 1) {
    return sum + tax;
  }
  return sum;
}

const items: Item[] = [{ name: 'a', price: 2 }, { name: 'b', price: 3 }];
const rate = 0.25;
const [first] = items;
const label = `#${first!.name}`;
console.log(label, total(items, rate));
