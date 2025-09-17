# API-ANALYSIS.md

## Current URL Structure and API Expectations in Tastic-Flasher

### Summary
The tastic-flasher has multiple conflicting URL patterns that expect different hosting approaches. Some expect individual firmware files to be accessible via HTTP, while others download ZIP files and extract contents. This analysis identifies all URL patterns and API expectations.

## 1. Firmware Listing API

**Current Implementation:**
```typescript
// stores/firmwareStore.ts:96
const response = await fetch('./firmware-releases.json');
```

**Expected Structure:**
```json
{
  "releases": {
    "stable": [
      {
        "id": "tastic-v0.0.5",
        "title": "Tastic Mesh Firmware v0.0.5",
        "page_url": "https://github.com/roperscrossroads/tasticfw/releases/tag/tastic-v0.0.5",
        "zip_url": "https://github.com/roperscrossroads/tasticfw/releases/download/tastic-v0.0.5/firmware-heltec-v3-tastic-v0.0.5.zip",
        "release_notes": "..."
      }
    ],
    "alpha": [],
    "pullRequests": []
  }
}
```

**Status:** ✅ WORKING - Static JSON file served from `/public/firmware-releases.json`

## 2. Device Hardware API

**Current Implementation:**
```typescript
// stores/deviceStore.ts:102 & :108
const targets = await firmwareApi.get<DeviceHardware[]>(); // Tries api.meshtastic.org
const response = await fetch('/data/hardware-list.json'); // Fallback
```

**Expected Structure:**
```json
[
  {
    "hwModel": 43,
    "hwModelSlug": "HELTEC_V3",
    "platformioTarget": "heltec-v3",
    "architecture": "esp32s3",
    "activelySupported": true,
    "displayName": "Heltec WiFi LoRa 32 V3",
    "images": ["heltec-v3.svg"],
    "requiresDfu": false
  }
]
```

**Status:** ✅ WORKING - Static JSON file served from `/public/device-hardware.json`

## 3. Firmware Binary Files - PROBLEMATIC PATTERNS

### 3.1. Individual File URLs (getReleaseFileUrl)

**Current Implementation:**
```typescript
// stores/firmwareStore.ts:179
const baseUrl = `https://roperscrossroads.github.io/tasticfw/firmware/${this.selectedFirmware.id}`;
return `${baseUrl}/${fileName}`;
```

**Used By:**
- `components/Flash.vue:62` - Checks if `.uf2` files exist
- `components/Flash.vue:66` - Checks if `.bin` files exist
- `components/targets/Esp32.vue:216` - Checks if `littlefswebui*.bin` exists
- `components/targets/Uf2.vue:132` - Direct download links for `.uf2` files

**Expected URLs:**
```
https://roperscrossroads.github.io/tasticfw/firmware/tastic-v0.0.5/firmware-heltec-v3-tastic-v0.0.5.bin
https://roperscrossroads.github.io/tasticfw/firmware/tastic-v0.0.5/firmware-heltec-v3-tastic-v0.0.5.uf2
https://roperscrossroads.github.io/tasticfw/firmware/tastic-v0.0.5/littlefswebui-heltec-v3-tastic-v0.0.5.bin
```

**Status:** ❌ BROKEN - These URLs don't exist! Files are inside ZIP files.

### 3.2. ZIP File Downloads (fetchBinaryContent)

**Current Implementation:**
```typescript
// stores/firmwareStore.ts:412-441
if (this.selectedFirmware.zip_url.includes('/releases/download/')) {
  const response = await fetch(this.selectedFirmware.zip_url);
  // Extract individual files from ZIP
}
```

**Expected URLs:**
```
https://github.com/roperscrossroads/tasticfw/releases/download/tastic-v0.0.5/firmware-heltec-v3-tastic-v0.0.5.zip
https://github.com/roperscrossroads/tasticfw/releases/download/tastic-v0.0.5/firmware-tracker-t1000-e-tastic-v0.0.5.zip
https://github.com/roperscrossroads/tasticfw/releases/download/tastic-v0.0.5/firmware-seeed_xiao_nrf52840_kit-tastic-v0.0.5.zip
```

**Status:** ✅ WORKING - Downloads and extracts from GitHub Release ZIPs

### 3.3. Legacy CORS-friendly URLs (Fallback)

**Current Implementation:**
```typescript
// types/api.ts:44
return `https://raw.githubusercontent.com/meshtastic/meshtastic.github.io/master/${firmwareName}`;
```

**Status:** ❌ BROKEN - Points to original Meshtastic, not tastic firmware

## 4. File Existence Checking

**Current Implementation:**
```typescript
// utils/fileUtils.ts:20
export async function checkIfRemoteFileExists(url: string): Promise<boolean> {
  const response = await fetch(url, { method: 'HEAD' });
  return response.ok;
}
```

**Problem:** This expects individual files to be accessible via HTTP HEAD requests, but files are inside ZIP files.

**Used By:**
- Flash button enablement logic
- WebUI bundling availability checks
- UF2 download availability

## 5. Current GitHub Release Assets

**Available Files:**
```
https://github.com/roperscrossroads/tasticfw/releases/download/tastic-v0.0.5/firmware-heltec-v3-tastic-v0.0.5.zip
https://github.com/roperscrossroads/tasticfw/releases/download/tastic-v0.0.5/firmware-tracker-t1000-e-tastic-v0.0.5.zip
https://github.com/roperscrossroads/tasticfw/releases/download/tastic-v0.0.5/firmware-seeed_xiao_nrf52840_kit-tastic-v0.0.5.zip
https://github.com/roperscrossroads/tasticfw/releases/download/tastic-v0.0.5/tastic-firmware-tastic-v0.0.5-all.zip
```

**ZIP Contents (example):**
```
firmware-heltec-v3-tastic-v0.0.5/
├── firmware.bin
├── firmware.factory.bin
├── littlefs.bin
└── (other ESP32 files)
```

## 6. Solutions Analysis

### Option A: GitHub Pages Deployment (Static Files)
**Pros:**
- Zero-cost hosting
- Direct HTTP access to individual files
- Works with existing file existence checks
- Simple CORS handling

**Cons:**
- Requires workflow modification to extract ZIPs
- Increases build complexity
- GitHub Pages storage usage

**Implementation:**
Extract all ZIP contents to `firmware/${version}/` directory structure:
```
https://roperscrossroads.github.io/tasticfw/firmware/tastic-v0.0.5/firmware-heltec-v3-tastic-v0.0.5.bin
https://roperscrossroads.github.io/tasticfw/firmware/tastic-v0.0.5/firmware-heltec-v3-tastic-v0.0.5.factory.bin
https://roperscrossroads.github.io/tasticfw/firmware/tastic-v0.0.5/littlefs-heltec-v3-tastic-v0.0.5.bin
```

### Option B: ZIP-Only Approach (Client-Side Extraction)
**Pros:**
- Uses existing GitHub Releases
- No additional hosting needed
- Already partially implemented

**Cons:**
- Requires rewriting file existence checks
- More complex client-side logic
- Slower (download ZIP to check file existence)

**Implementation:**
1. Replace `checkIfRemoteFileExists` with ZIP manifest checking
2. Update all components to work with ZIP-based files
3. Implement client-side file extraction for all use cases

### Option C: Real API Server
**Pros:**
- Full control over file serving
- Can implement any URL pattern
- Database-backed firmware management

**Cons:**
- Hosting costs
- Server maintenance
- More complex deployment

## 7. Recommendations

### Immediate Fix (Option A): GitHub Pages Static Deployment
This is the most compatible approach that requires minimal code changes:

1. **Modify GitHub Actions workflow** to extract ZIP contents to GitHub Pages
2. **Maintain current flasher logic** - no code changes needed
3. **URL structure remains the same** - existing file checks work

### Long-term (Option B): ZIP-Only with Smart Caching
For a more robust solution:

1. **Create ZIP manifest system** - check file existence without downloading
2. **Implement client-side caching** - cache ZIP contents for faster access
3. **Update file existence checks** to work with ZIP manifests

## 8. Current Issues Causing Problems

1. **Flash button not enabling after auto-detect**: `checkIfRemoteFileExists` fails because individual files don't exist
2. **Blank popup on manual flash**: ZIP download works, but other components still expect individual files
3. **WebUI bundling checks failing**: `littlefswebui*.bin` file existence checks fail

**Root Cause:** Mixed architecture - some code expects individual files, some works with ZIPs.