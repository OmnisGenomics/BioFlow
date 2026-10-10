console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(),
  marker: process.env.BIOFLOW_ARGV_TEST_MARKER }));
