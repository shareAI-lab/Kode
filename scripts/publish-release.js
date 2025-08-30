#!/usr/bin/env node

const { execSync } = require('child_process');
const { readFileSync, writeFileSync } = require('fs');
const path = require('path');
const readline = require('readline');

/**
 * 发布正式版本到 npm
 * 使用 latest tag，支持语义化版本升级
 */
async function publishRelease() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const question = (query) => new Promise(resolve => rl.question(query, resolve));

  try {
    console.log('🚀 Starting production release process...\n');

    // 1. 确保在主分支
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    if (currentBranch !== 'main' && currentBranch !== 'master') {
      console.log('⚠️  Not on main/master branch. Current branch:', currentBranch);
      const proceed = await question('Continue anyway? (y/N): ');
      if (proceed.toLowerCase() !== 'y') {
        console.log('❌ Cancelled');
        process.exit(0);
      }
    }

    // 2. 检查工作区是否干净
    try {
      execSync('git diff --exit-code', { stdio: 'ignore' });
      execSync('git diff --cached --exit-code', { stdio: 'ignore' });
      console.log('✅ Working directory is clean');
    } catch {
      console.log('❌ Working directory has uncommitted changes');
      console.log('Please commit or stash your changes before releasing');
      process.exit(1);
    }

    // 3. 拉取最新代码
    console.log('📡 Pulling latest changes...');
    execSync('git pull origin ' + currentBranch, { stdio: 'inherit' });

    // 4. 读取当前版本
    const packagePath = path.join(process.cwd(), 'package.json');
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
    const currentVersion = packageJson.version;

    console.log(`📦 Current version: ${currentVersion}`);

    // 5. 选择版本升级类型
    console.log('\n🔢 Version bump options:');
    const versionParts = currentVersion.split('.');
    const major = parseInt(versionParts[0]);
    const minor = parseInt(versionParts[1]);
    const patch = parseInt(versionParts[2]);

    console.log(`  1. patch  → ${major}.${minor}.${patch + 1} (bug fixes)`);
    console.log(`  2. minor  → ${major}.${minor + 1}.0 (new features)`);
    console.log(`  3. major  → ${major + 1}.0.0 (breaking changes)`);
    console.log(`  4. custom → enter custom version`);

    const choice = await question('\nSelect version bump (1-4): ');
    
    let newVersion;
    switch (choice) {
      case '1':
        newVersion = `${major}.${minor}.${patch + 1}`;
        break;
      case '2':
        newVersion = `${major}.${minor + 1}.0`;
        break;
      case '3':
        newVersion = `${major + 1}.0.0`;
        break;
      case '4':
        newVersion = await question('Enter custom version: ');
        break;
      default:
        console.log('❌ Invalid choice');
        process.exit(1);
    }

    // 6. 确认发布
    console.log(`\n📋 Release Summary:`);
    console.log(`   Current: ${currentVersion}`);
    console.log(`   New:     ${newVersion}`);
    console.log(`   Branch:  ${currentBranch}`);
    console.log(`   Tag:     latest`);

    const confirm = await question('\n🤔 Proceed with release? (y/N): ');
    if (confirm.toLowerCase() !== 'y') {
      console.log('❌ Cancelled');
      process.exit(0);
    }

    // 7. 更新版本号
    console.log('📝 Updating version...');
    packageJson.version = newVersion;
    writeFileSync(packagePath, JSON.stringify(packageJson, null, 2));

    // 8. 运行测试
    console.log('🧪 Running tests...');
    try {
      execSync('npm run typecheck', { stdio: 'inherit' });
      execSync('npm test', { stdio: 'inherit' });
    } catch (error) {
      console.log('❌ Tests failed, rolling back version...');
      packageJson.version = currentVersion;
      writeFileSync(packagePath, JSON.stringify(packageJson, null, 2));
      process.exit(1);
    }

    // 9. 构建项目
    console.log('🔨 Building project...');
    execSync('npm run build', { stdio: 'inherit' });

    // 10. 运行预发布检查
    console.log('🔍 Running pre-publish checks...');
    execSync('node scripts/prepublish-check.js', { stdio: 'inherit' });

    // 11. 提交版本更新
    console.log('📝 Committing version update...');
    execSync('git add package.json');
    execSync(`git commit -m "chore: bump version to ${newVersion}"`);

    // 12. 创建 git tag
    console.log('🏷️  Creating git tag...');
    execSync(`git tag -a v${newVersion} -m "Release ${newVersion}"`);

    // 13. 发布到 npm
    console.log('📤 Publishing to npm...');
    execSync('npm publish --access public', { stdio: 'inherit' });

    // 14. 推送到 git
    console.log('📡 Pushing to git...');
    execSync(`git push origin ${currentBranch}`);
    execSync(`git push origin v${newVersion}`);

    console.log('\n🎉 Production release published successfully!');
    console.log(`📦 Version: ${newVersion}`);
    console.log(`🔗 Install with: npm install -g @shareai-lab/kode`);
    console.log(`🔗 Or: npm install -g @shareai-lab/kode@${newVersion}`);
    console.log(`📊 View on npm: https://www.npmjs.com/package/@shareai-lab/kode`);

  } catch (error) {
    console.error('❌ Production release failed:', error.message);
    process.exit(1);
  } finally {
    rl.close();
  }
}

publishRelease();