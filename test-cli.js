#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

console.log('Testing Kode CLI...\n');

// Test 1: Version
console.log('1. Testing version command:');
const versionProcess = spawn('node', ['cli.js', '--version'], { cwd: __dirname });
versionProcess.stdout.on('data', (data) => {
  console.log(`   Version: ${data.toString().trim()}`);
});

versionProcess.on('close', () => {
  // Test 2: Help
  console.log('\n2. Testing help command:');
  const helpProcess = spawn('node', ['cli.js', '--help'], { cwd: __dirname });
  
  helpProcess.stdout.on('data', (data) => {
    console.log(`   ${data.toString()}`);
  });
  
  helpProcess.stderr.on('data', (data) => {
    console.log(`   Error: ${data.toString()}`);
  });
  
  helpProcess.on('close', (code) => {
    console.log(`\n3. CLI help exited with code ${code}`);
    
    // Test 3: Quick interaction test
    console.log('\n4. Testing interactive mode (sending exit):');
    const interactiveProcess = spawn('node', ['cli.js'], { cwd: __dirname });
    
    interactiveProcess.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes('Kode') || output.includes('Welcome') || output.includes('>')) {
        console.log('   ✓ CLI started successfully');
        interactiveProcess.stdin.write('exit\n');
      }
    });
    
    interactiveProcess.stderr.on('data', (data) => {
      console.log(`   Stderr: ${data.toString()}`);
    });
    
    setTimeout(() => {
      interactiveProcess.kill();
      console.log('\n✅ All basic CLI tests completed');
      process.exit(0);
    }, 2000);
  });
});