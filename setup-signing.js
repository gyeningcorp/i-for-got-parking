#!/usr/bin/env node
/**
 * setup-signing.js
 * Creates an iOS distribution certificate + App Store provisioning profile
 * using the App Store Connect REST API. No Xcode/Mac required.
 */

const https = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ASC_KEY_ID    = process.env.ASC_KEY_ID;
const ASC_ISSUER_ID = process.env.ASC_ISSUER_ID;
const ASC_KEY_PATH  = process.env.ASC_KEY_PATH;
const BUNDLE_ID_STR = process.env.BUNDLE_ID || 'com.gyeningcorp.parkspot';
const TEAM_ID       = process.env.TEAM_ID   || '4LZJ7U5FHS';

// ── JWT ──────────────────────────────────────────────────────────────────────
function makeJWT() {
  const privKey = fs.readFileSync(ASC_KEY_PATH, 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg:'ES256', kid:ASC_KEY_ID, typ:'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss:ASC_ISSUER_ID, iat:now, exp:now+1200, aud:'appstoreconnect-v1' })).toString('base64url');
  const toSign  = `${header}.${payload}`;
  const sign    = crypto.createSign('SHA256');
  sign.update(toSign);
  // sign with IEEE P1363 format (raw r||s) for ES256
  const sigDer   = sign.sign({ key: privKey, dsaEncoding: 'ieee-p1363' });
  const sigB64   = sigDer.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  return `${toSign}.${sigB64}`;
}

// ── API helper ───────────────────────────────────────────────────────────────
function apiCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const token = makeJWT();
    const data  = body ? JSON.stringify(body) : null;
    const opts  = {
      hostname: 'api.appstoreconnect.apple.com',
      path, method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const TMP = process.env.RUNNER_TEMP || '/tmp';

  // 1. Generate distribution private key + CSR
  console.log('🔑 Generating distribution key pair (RSA 2048)...');
  const distKeyPath = path.join(TMP, 'dist_key.pem');
  const csrPath     = path.join(TMP, 'dist.csr');
  execSync(`openssl genrsa -out ${distKeyPath} 2048`);
  execSync(`openssl req -new -key ${distKeyPath} -out ${csrPath} -subj "/CN=iPhone Distribution: Christopher Gyening/O=Christopher Gyening/C=US"`);
  const csrDer = execSync(`openssl req -in ${csrPath} -outform DER`);
  const csrB64 = csrDer.toString('base64');

  // 2. Delete any existing iOS Distribution certificates, then create fresh one
  console.log('🧹 Removing existing iOS Distribution certificates...');
  const existingCerts = await apiCall('GET', '/v1/certificates?filter[certificateType]=IOS_DISTRIBUTION');
  if (existingCerts.body.data && existingCerts.body.data.length > 0) {
    for (const c of existingCerts.body.data) {
      console.log(`🗑️  Deleting cert: ${c.id}`);
      await apiCall('DELETE', `/v1/certificates/${c.id}`);
    }
  }

  console.log('📜 Creating iOS Distribution certificate via ASC API...');
  const certRes = await apiCall('POST', '/v1/certificates', {
    data: {
      type: 'certificates',
      attributes: { certificateType: 'IOS_DISTRIBUTION', csrContent: csrB64 }
    }
  });
  if (certRes.status !== 201) {
    console.error('Certificate creation failed:', JSON.stringify(certRes.body, null, 2));
    process.exit(1);
  }
  const certId      = certRes.body.data.id;
  const certContent = certRes.body.data.attributes.certificateContent; // base64 DER
  console.log(`✅ Certificate created: ${certId}`);

  // Save cert and create .p12
  const cerPath = path.join(TMP, 'apple_dist.cer');
  const pemPath = path.join(TMP, 'apple_dist.pem');
  const p12Path = path.join(TMP, 'dist.p12');
  fs.writeFileSync(cerPath, Buffer.from(certContent, 'base64'));
  execSync(`openssl x509 -inform DER -in ${cerPath} -out ${pemPath}`);
  execSync(`openssl pkcs12 -export -out ${p12Path} -inkey ${distKeyPath} -in ${pemPath} -passout pass:TempP4ss!`);

  // Import into default keychain
  console.log('🔐 Importing certificate into keychain...');
  execSync(`security import ${p12Path} -k ~/Library/Keychains/login.keychain-db -P "TempP4ss!" -T /usr/bin/codesign -T /usr/bin/security`);
  execSync(`security set-key-partition-list -S apple-tool:,apple: -s -k "" ~/Library/Keychains/login.keychain-db 2>/dev/null || true`);

  // 3. Get bundleId record
  console.log('📦 Looking up Bundle ID...');
  const bundleRes = await apiCall('GET', `/v1/bundleIds?filter[identifier]=${BUNDLE_ID_STR}`);
  let bundleIdRecord;
  if (bundleRes.body.data && bundleRes.body.data.length > 0) {
    bundleIdRecord = bundleRes.body.data[0];
    console.log(`✅ Found bundle ID: ${bundleIdRecord.id}`);
  } else {
    // Register it
    console.log('Registering bundle ID...');
    const regRes = await apiCall('POST', '/v1/bundleIds', {
      data: {
        type: 'bundleIds',
        attributes: { identifier: BUNDLE_ID_STR, name: 'IForGotParking', platform: 'IOS' }
      }
    });
    bundleIdRecord = regRes.body.data;
    console.log(`✅ Registered bundle ID: ${bundleIdRecord.id}`);
  }

  // 4. Create App Store distribution profile (delete duplicates first)
  console.log('📋 Checking for existing provisioning profiles...');
  const existingProfiles = await apiCall('GET', '/v1/profiles?filter[name]=IForGotParking%20AppStore&filter[profileType]=IOS_APP_STORE');
  if (existingProfiles.body.data && existingProfiles.body.data.length > 0) {
    for (const p of existingProfiles.body.data) {
      console.log(`🗑️  Deleting duplicate profile: ${p.id}`);
      await apiCall('DELETE', `/v1/profiles/${p.id}`);
    }
  }

  console.log('📋 Creating App Store distribution provisioning profile...');
  const profileRes = await apiCall('POST', '/v1/profiles', {
    data: {
      type: 'profiles',
      attributes: { name: 'IForGotParking AppStore', profileType: 'IOS_APP_STORE' },
      relationships: {
        bundleId:     { data: { type: 'bundleIds',     id: bundleIdRecord.id } },
        certificates: { data: [{ type: 'certificates', id: certId }] }
      }
    }
  });
  if (profileRes.status !== 201) {
    console.error('Profile creation failed:', JSON.stringify(profileRes.body, null, 2));
    process.exit(1);
  }
  const profileContent = profileRes.body.data.attributes.profileContent; // base64
  const profileUUID    = profileRes.body.data.attributes.uuid;
  console.log(`✅ Profile created: ${profileUUID}`);

  // Install provisioning profile
  const profileDir  = path.join(process.env.HOME, 'Library/MobileDevice/Provisioning Profiles');
  execSync(`mkdir -p "${profileDir}"`);
  const profilePath = path.join(profileDir, `${profileUUID}.mobileprovision`);
  fs.writeFileSync(profilePath, Buffer.from(profileContent, 'base64'));
  console.log(`✅ Profile installed: ${profilePath}`);

  // Write env vars for next steps
  const githubEnv = process.env.GITHUB_ENV;
  if (githubEnv) {
    fs.appendFileSync(githubEnv, `DIST_PROFILE_UUID=${profileUUID}\n`);
    fs.appendFileSync(githubEnv, `DIST_CERT_ID=${certId}\n`);
  }
  console.log('\n🎉 Signing setup complete!');
  console.log(`   Profile UUID: ${profileUUID}`);
}

main().catch(e => { console.error(e); process.exit(1); });
