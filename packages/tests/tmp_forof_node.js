try { for (const x of null) {} } catch(e) { console.log('null:', e.message); }
try { for (const x of undefined) {} } catch(e) { console.log('undef:', e.message); }
try { for (const x of 1) {} } catch(e) { console.log('num:', e.message); }
function f(xs) { let s=0; for (const x of xs) s+=x; return s; }
console.log('sum', f([1,2,3]));
