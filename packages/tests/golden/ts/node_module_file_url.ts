// createRequire of a file: URL under --node (pyrlyn/stator#335): a query is dropped the way Node
// drops it, and a rejected host throws Node's createRequire code.
import { createRequire } from 'node:module';

function report(href: string): void {
  try {
    createRequire(href);
    console.log(href, 'ok');
  } catch (e) {
    const failure = e as { readonly code: string };
    console.log(href, failure.code);
  }
}

report('file:///x?q');
report('file://host/x');
report('file:///a%2Fb');
