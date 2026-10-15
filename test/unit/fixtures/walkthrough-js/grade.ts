function grade(n: number): string {
  if (n > 90) {
    return 'A';
  } else if (n > 80) {
    return 'B';
  } else {
    return 'C';
  }
}
let out = [];
for (const n of [95, 85, 70]) out.push(grade(n));
let i = 0;
while (i < 2) i++;
switch (out[0]) {
  case 'A':
    console.log('top');
    break;
  default:
    console.log('other');
}
