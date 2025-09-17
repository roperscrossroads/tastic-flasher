import {
  ESPLoader,
  type FlashOptions,
  type LoaderOptions,
  Transport,
} from 'esptool-js';
import { saveAs } from 'file-saver';
import { mande } from 'mande';
import { defineStore } from 'pinia';
import type { Terminal } from 'xterm';
import { supportsNew8MBPartitionTable } from '~/utils/versionUtils';
import {
  currentPrerelease,
  showPrerelease,
} from '~/types/resources';

import { track } from '@vercel/analytics';
import { useSessionStorage } from '@vueuse/core';
import {
  BlobReader,
  BlobWriter,
  ZipReader,
} from '@zip.js/zip.js';

import {
  type DeviceHardware,
  type FirmwareReleases,
  type FirmwareResource,
  getCorsFriendyReleaseUrl,
} from '../types/api';
import { createUrl } from './store';

const previews = showPrerelease ? [currentPrerelease] : [];

const firmwareApi = mande(createUrl('api/github/firmware/list'))

export const useFirmwareStore = defineStore('firmware', {
  state: () => {
    return {
      stable: new Array<FirmwareResource>(),
      alpha: new Array<FirmwareResource>(),
      previews: previews,
      pullRequests: new Array<FirmwareResource>(),
      selectedFirmware: <FirmwareResource | undefined>{},
      selectedFile: <File | undefined>{},
      baudRate: 115200,
      hasSeenReleaseNotes: false,
      shouldCleanInstall: false,
      shouldBundleWebUI: false,
      shouldInstallMui: false,
      shouldInstallInkHud: false,
      partitionScheme: <String | undefined>{},
      flashPercentDone: 0,
      isFlashing: false,
      flashingIndex: 0,
      isReaderLocked: false,
      isConnected: false,
      port: <SerialPort | undefined>{},
      couldntFetchFirmwareApi: false,
      prereleaseUnlocked: useSessionStorage('prereleaseUnlocked', false),
    }
  },
  getters: {
    hasOnlineFirmware: (state) => {
      const result = (state.selectedFirmware?.id || '').length > 0;
      console.log('🔍 [Firmware] hasOnlineFirmware:', result, 'selectedFirmware:', state.selectedFirmware);
      return result;
    },
    hasFirmwareFile: (state) => {
      const result = (state.selectedFile?.name || '').length > 0;
      console.log('🔍 [Firmware] hasFirmwareFile:', result, 'selectedFile:', state.selectedFile);
      return result;
    },
    percentDone: (state) => `${state.flashPercentDone}%`,
    firmwareVersion: (state) => state.selectedFirmware?.id ? state.selectedFirmware.id.replace(/^v/, '') : '.+',
    canShowFlash: (state) => {
      const result = !!state.selectedFirmware?.id;
      console.log('🚀 [Firmware] canShowFlash:', result, 'selectedFirmware.id:', state.selectedFirmware?.id, 'selectedFirmware.zip_url:', state.selectedFirmware?.zip_url);
      return result;
    },
    isZipFile: (state) => state.selectedFile?.name.endsWith('.zip'),
    isFactoryBin: (state) => state.selectedFile?.name.endsWith('.factory.bin'),
  },
  actions: {
    clearState() {
      this.shouldCleanInstall = false;
      this.shouldBundleWebUI = false;
      this.shouldInstallMui = false;
      this.shouldInstallInkHud = false;
      this.partitionScheme = undefined;
    },
    continueToFlash() {
      this.hasSeenReleaseNotes = true
    },
    async fetchList() {
      try {
        // Fetch from static JSON instead of API
        const response = await fetch('./firmware-releases.json');
        const data = await response.json();

        this.stable = data.releases.stable.slice(0, 4);
        this.alpha = data.releases.alpha.slice(0, 4);
        this.previews = previews; // Keep existing previews
        this.pullRequests = data.pullRequests || [];
      } catch (error) {
        console.error('Error fetching firmware list:', error);
        this.couldntFetchFirmwareApi = true;

        // Fallback to hardcoded if JSON fails
        this.stable = [
          {
            id: 'tastic-v0.0.3',
            title: 'Tastic Mesh Firmware v0.0.3',
            page_url: 'https://github.com/roperscrossroads/tasticfw/releases/tag/tastic-v0.0.3',
            zip_url: 'https://github.com/roperscrossroads/tasticfw/releases/download/tastic-v0.0.3/firmware-tracker-t1000-e-tastic-v0.0.3.zip',
            release_notes: 'Fallback firmware'
          }
        ];
      }
    },
    async setSelectedFirmware(firmware: FirmwareResource) {
      console.log('🔧 [Firmware] Setting selected firmware:', firmware);
      this.selectedFirmware = firmware;
      this.selectedFile = undefined;
      this.hasSeenReleaseNotes = false;
      // Store current MUI setting before clearing state
      const currentMuiSetting = this.shouldInstallMui;
      this.clearState();
      // Restore MUI setting if it was enabled (for devices that support it)
      this.shouldInstallMui = currentMuiSetting;

      // Update firmware zip_url based on selected device
      this.updateFirmwareZipUrl();

      // Update Datadog RUM context with firmware version
      if (import.meta.client) {
        try {
          const { datadogRum } = await import('@datadog/browser-rum');
          datadogRum.setGlobalContextProperty('firmware_version', firmware.id);
        } catch (error) {
          console.error('Error setting Datadog RUM context:', error);
        }
      }
    },
    updateFirmwareZipUrl() {
      console.log('🔗 [Firmware] Updating firmware zip URL...');
      if (!this.selectedFirmware?.id) {
        console.log('❌ [Firmware] No selected firmware ID');
        return;
      }

      // Import device store dynamically to avoid circular dependency
      const { useDeviceStore } = require('./deviceStore');
      const deviceStore = useDeviceStore();
      const selectedTarget = deviceStore.selectedTarget;

      console.log('🎯 [Firmware] Selected target:', selectedTarget);

      if (selectedTarget?.platformioTarget) {
        // Generate device-specific zip URL
        const deviceSpecificZipUrl = `https://github.com/roperscrossroads/tasticfw/releases/download/${this.selectedFirmware.id}/firmware-${selectedTarget.platformioTarget}-${this.selectedFirmware.id}.zip`;

        // Update the firmware object with device-specific zip URL
        if (this.selectedFirmware) {
          this.selectedFirmware = {
            ...this.selectedFirmware,
            zip_url: deviceSpecificZipUrl
          };
        }

        console.log(`✅ [Firmware] Updated firmware zip_url for ${selectedTarget.platformioTarget}:`, deviceSpecificZipUrl);
      } else {
        console.log('❌ [Firmware] No selected target platformioTarget');
      }
    },
    getReleaseFileUrl(fileName: string): string {
      if (!this.selectedFirmware?.id) return '';
      // Use GitHub Pages URL for CORS-free access to firmware files
      const baseUrl = `https://roperscrossroads.github.io/tasticfw/firmware/${this.selectedFirmware.id}`;
      return `${baseUrl}/${fileName}`;
    },
    async downloadUf2FileSystem(searchRegex: RegExp) {
      if (!this.selectedFile) return;
      const reader = new BlobReader(this.selectedFile);
      const zipReader = new ZipReader(reader);
      const entries = await zipReader.getEntries()
      console.log('Zip entries:', entries);
      const file = entries.find(entry => searchRegex.test(entry.filename))
      if (file) {
        if (file?.getData) {
          const data = await file.getData(new BlobWriter());
          saveAs(data, file.filename);
        } else {
          throw new Error(`Could not find file with pattern ${searchRegex} in zip`);
        }
      }
      else {
        throw new Error(`Could not find file with pattern ${searchRegex} in zip`);
      }
      zipReader.close();
    },
    async setFirmwareFile(file: File) {
      this.selectedFile = file;
      this.selectedFirmware = undefined;
      // Store current MUI setting before clearing state
      const currentMuiSetting = this.shouldInstallMui;
      this.clearState();
      // Restore MUI setting if it was enabled (for devices that support it)
      this.shouldInstallMui = currentMuiSetting;
    },
    async updateEspFlash(fileName: string, selectedTarget: DeviceHardware) {
      console.log('⚡ [Flash] Starting updateEspFlash');
      console.log('⚡ [Flash] fileName:', fileName);
      console.log('⚡ [Flash] selectedTarget:', selectedTarget);
      console.log('⚡ [Flash] selectedFirmware:', this.selectedFirmware);

      const terminal = await openTerminal();
      console.log('⚡ [Flash] Terminal opened');

      try {
        console.log('⚡ [Flash] Requesting serial port...');
        this.port = await navigator.serial.requestPort({});
        console.log('⚡ [Flash] Serial port obtained:', this.port);
        this.isConnected = true;
        this.port.ondisconnect = () => {
          console.log('⚡ [Flash] Serial port disconnected');
          this.isConnected = false;
        };
        const transport = new Transport(this.port, true);
        console.log('⚡ [Flash] Transport created');

        console.log('⚡ [Flash] Connecting to ESP32...');
        const espLoader = await this.connectEsp32(transport, terminal);
        console.log('⚡ [Flash] ESP32 connected');

        console.log('⚡ [Flash] Fetching binary content for:', fileName);
        const content = await this.fetchBinaryContent(fileName);
        console.log('⚡ [Flash] Binary content fetched, size:', content.length);
        this.isFlashing = true;
        const flashOptions: FlashOptions = {
          fileArray: [{ data: content, address: 0x10000 }],
          flashSize: 'keep',
          eraseAll: false,
          compress: true,
          flashMode: 'keep',
          flashFreq: 'keep',
          reportProgress: (fileIndex, written, total) => {
            this.flashPercentDone = Math.round((written / total) * 100);
            if (written === total) {
              this.isFlashing = false;
              console.log('Done flashing!');
              this.trackDownload(selectedTarget, true);
            }
          },
        };
        await this.startWrite(terminal, espLoader, transport, flashOptions);
      }
      catch (error: any) {
        console.error('❌ [Flash] Error in updateEspFlash:', error);
        this.handleError(error, terminal);
      }
    },
    handleError(error: Error, terminal: Terminal) {
      console.error('❌ [Flash] handleError called with:', error);
      console.error('❌ [Flash] Error stack:', error.stack);
      terminal.writeln('');
      terminal.writeln(`\x1b[38;5;9m${error}\x1b[0m`);
    },
    async startWrite(terminal: Terminal, espLoader: ESPLoader, transport: Transport, flashOptions: FlashOptions) {
      await espLoader.writeFlash(flashOptions);
      await this.resetEsp32(transport);
      if (this.port) {
        await this.readSerial(this.port, terminal);
      } else {
        throw new Error('Serial port is not defined');
      }
    },
    async resetEsp32(transport: Transport) {
      await transport.setRTS(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await transport.setRTS(false);
    },
    trackDownload(selectedTarget: DeviceHardware, isCleanInstall: boolean) { 
      if (selectedTarget.hwModelSlug?.length > 0) {
        // Vercel Analytics tracking
        track('Download', { 
          hardwareModel: selectedTarget.hwModelSlug, 
          arch: selectedTarget.architecture, 
          cleanInstall: isCleanInstall,
          version: this.selectedFirmware?.id || '',
          count: 1 
        });

        // Datadog tracking - both RUM and Logs for comprehensive coverage
        if (import.meta.client) {
          const flashData = {
            firmware_version: this.selectedFirmware?.id || '',
            hw_model: selectedTarget.hwModel,
            hw_model_slug: selectedTarget.hwModelSlug,
            platformio_target: selectedTarget.platformioTarget,
            architecture: selectedTarget.architecture,
            clean_install: isCleanInstall,
            support_level: selectedTarget.supportLevel || 3,
            has_mui: selectedTarget.hasMui || false,
            partition_scheme: this.partitionScheme || 'default',
            partition_table_version: this.partitionScheme === '8MB' && selectedTarget.hasMui && supportsNew8MBPartitionTable(this.firmwareVersion) ? 'new-8mb' : 'legacy',
            timestamp: new Date().toISOString(),
            user_agent: navigator.userAgent,
            url: window.location.href
          };

          // RUM Action (for user experience correlation, subject to sampling)
          import('@datadog/browser-rum').then(({ datadogRum }) => {
            datadogRum.addAction('firmware_flash', flashData);
          }).catch(error => {
            console.warn('Datadog RUM not available for flash tracking:', error);
          });

          // Datadog Logs (for precise counting, no sampling)
          import('@datadog/browser-logs').then(({ datadogLogs }) => {
            datadogLogs.logger.info('Firmware flash completed', {
              event_type: 'firmware_flash',
              ...flashData
            });
          }).catch(error => {
            console.warn('Datadog Logs not available for flash tracking:', error);
          });
        }
      }
    },
    async cleanInstallEspFlash(fileName: string, otaFileName: string, littleFsFileName: string, selectedTarget: DeviceHardware) {
      const terminal = await openTerminal();

      try {
        this.port = await navigator.serial.requestPort({});
        this.isConnected = true;
        this.port.ondisconnect = () => {
          this.isConnected = false;
        };
        const transport = new Transport(this.port, true);
        const espLoader = await this.connectEsp32(transport, terminal);
        const appContent = await this.fetchBinaryContent(fileName);
        const otaContent = await this.fetchBinaryContent(otaFileName);
        const littleFsContent = await this.fetchBinaryContent(littleFsFileName);

        let otaOffset = 0x260000;
        let spiffsOffset = 0x300000;
        
        if (this.partitionScheme == "8MB") {
          // Check if this is a TFT (MUI) device with firmware 2.7.9+ that should use the new partition table
          const isTftDevice = selectedTarget.hasMui === true;
          const useNewPartitionTable = isTftDevice && supportsNew8MBPartitionTable(this.firmwareVersion);
          
          console.log(`8MB partition selection: TFT device: ${isTftDevice}, Firmware: ${this.firmwareVersion}, Use new table: ${useNewPartitionTable}`);
          
          if (useNewPartitionTable) {
            // New 8MB partition table for TFT devices (firmware 2.7.9+)
            // Based on: https://github.com/meshtastic/firmware/blob/d43bd7f45b1c19d95288b5589adda2c0ef117bc4/partition-table-8MB.csv
            // flashApp (ota_1): 0x5D0000, spiffs: 0x670000
            otaOffset = 0x5D0000;
            spiffsOffset = 0x670000;
            console.log(`Using new 8MB partition table: OTA at 0x${otaOffset.toString(16)}, SPIFFS at 0x${spiffsOffset.toString(16)}`);
          } else {
            // Legacy 8MB partition table
            otaOffset = 0x340000;
            spiffsOffset = 0x670000;
            console.log(`Using legacy 8MB partition table: OTA at 0x${otaOffset.toString(16)}, SPIFFS at 0x${spiffsOffset.toString(16)}`);
          }
        }
        else if (this.partitionScheme == "16MB") {
          // 16mb
          otaOffset = 0x650000;
          spiffsOffset = 0xc90000;
        }

        this.isFlashing = true;
        const flashOptions: FlashOptions = {
          fileArray: [
            { data: appContent, address: 0x00 },
            { data: otaContent, address: otaOffset },
            { data: littleFsContent, address: spiffsOffset }
          ],
          flashSize: 'keep',
          eraseAll: true,
          compress: true,
          flashMode: 'keep',
          flashFreq: 'keep',
          reportProgress: (fileIndex, written, total) => {
            this.flashingIndex = fileIndex;
            this.flashPercentDone = Math.round((written / total) * 100);
            if (written === total && fileIndex > 1) {
              this.isFlashing = false;
              console.log('Done flashing!');
              this.trackDownload(selectedTarget, true);
            }
          },
        };
        await this.startWrite(terminal, espLoader, transport, flashOptions);
      } catch (error: any) {
        this.handleError(error, terminal);
      }
    },
    async fetchBinaryContent(fileName: string): Promise<string> {
      console.log('📦 [FetchBinary] Starting fetchBinaryContent for fileName:', fileName);
      console.log('📦 [FetchBinary] selectedFirmware:', this.selectedFirmware);
      console.log('📦 [FetchBinary] selectedFile:', this.selectedFile);

      // First, try to fetch directly from GitHub Pages (faster and simpler)
      if (this.selectedFirmware?.id) {
        const githubPagesUrl = this.getReleaseFileUrl(fileName);
        console.log('📦 [FetchBinary] Trying GitHub Pages direct access:', githubPagesUrl);

        try {
          const response = await fetch(githubPagesUrl);
          console.log('📦 [FetchBinary] GitHub Pages response status:', response.status, response.statusText);

          if (response.ok) {
            const blob = await response.blob();
            const data = await blob.arrayBuffer();
            console.log('✅ [FetchBinary] Successfully fetched from GitHub Pages, size:', data.byteLength, 'bytes');
            return convertToBinaryString(new Uint8Array(data));
          } else {
            console.log('📦 [FetchBinary] GitHub Pages failed, trying ZIP fallback...');
          }
        } catch (error) {
          console.log('📦 [FetchBinary] GitHub Pages error, trying ZIP fallback:', error);
        }
      }

      // Fallback to ZIP download if GitHub Pages fails
      if (this.selectedFirmware?.zip_url) {
        console.log('📦 [FetchBinary] Using ZIP fallback with zip_url:', this.selectedFirmware.zip_url);

        // Check if the zip_url is a GitHub release (contains /releases/download/)
        if (this.selectedFirmware.zip_url.includes('/releases/download/')) {
          // Download and extract from GitHub release ZIP
          console.log('📦 [FetchBinary] Detected GitHub release ZIP, fetching from:', this.selectedFirmware.zip_url);
          try {
            const response = await fetch(this.selectedFirmware.zip_url);
            console.log('📦 [FetchBinary] Fetch response status:', response.status, response.statusText);

            if (!response.ok) {
              throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const blob = await response.blob();
            console.log('📦 [FetchBinary] Downloaded blob size:', blob.size, 'bytes');

            // Extract the requested file from the ZIP
            const reader = new BlobReader(blob);
            const zipReader = new ZipReader(reader);
            const entries = await zipReader.getEntries();
            console.log('📦 [FetchBinary] ZIP entries:', entries.map(e => e.filename));
            console.log('📦 [FetchBinary] Looking for file matching pattern:', fileName);

            const file = entries.find(entry => {
              console.log('📦 [FetchBinary] Checking entry:', entry.filename, 'against pattern:', fileName);
              // Handle different naming patterns
              if (fileName.startsWith('firmware-tbeam-.')) {
                const match = !entry.filename.includes('s3') && new RegExp(fileName).test(entry.filename) && (fileName.endsWith('update.bin') === entry.filename.endsWith('update.bin'));
                console.log('📦 [FetchBinary] tbeam pattern match:', match);
                return match;
              }
              const match = new RegExp(fileName).test(entry.filename) && (fileName.endsWith('update.bin') === entry.filename.endsWith('update.bin'));
              console.log('📦 [FetchBinary] Regular pattern match:', match);
              return match;
            });

            if (file && file.getData) {
              console.log('✅ [FetchBinary] Found matching file:', file.filename);
              const fileBlob = await file.getData(new BlobWriter());
              const arrayBuffer = await fileBlob.arrayBuffer();
              console.log('✅ [FetchBinary] Extracted file size:', arrayBuffer.byteLength, 'bytes');
              zipReader.close();
              return convertToBinaryString(new Uint8Array(arrayBuffer));
            }
            zipReader.close();
            throw new Error(`Could not find file with pattern ${fileName} in zip`);
          } catch (error) {
            console.error('❌ [FetchBinary] Error fetching from GitHub release:', error);
            throw error;
          }
        } else {
          // Original behavior for GitHub Pages hosted files
          console.log('📦 [FetchBinary] Using legacy GitHub Pages fallback');
          const baseUrl = getCorsFriendyReleaseUrl(this.selectedFirmware.zip_url);
          console.log('📦 [FetchBinary] GitHub Pages base URL:', baseUrl);
          const fullUrl = `${baseUrl}/${fileName}`;
          console.log('📦 [FetchBinary] Fetching from:', fullUrl);
          const response = await fetch(fullUrl);
          console.log('📦 [FetchBinary] GitHub Pages response status:', response.status, response.statusText);
          const blob = await response.blob();
          const data = await blob.arrayBuffer();
          console.log('📦 [FetchBinary] GitHub Pages file size:', data.byteLength, 'bytes');
          return convertToBinaryString(new Uint8Array(data));
        }
      }
      if (this.selectedFile && this.isZipFile) {
        const reader = new BlobReader(this.selectedFile);
        const zipReader = new ZipReader(reader);
        const entries = await zipReader.getEntries()
        console.log('Zip entries:', entries);
        console.log('Looking for file matching pattern:', fileName);
        const file = entries.find(entry => 
          {
            if (fileName.startsWith('firmware-tbeam-.'))
              return !entry.filename.includes('s3') && new RegExp(fileName).test(entry.filename) && (fileName.endsWith('update.bin') === entry.filename.endsWith('update.bin'))
            return new RegExp(fileName).test(entry.filename) && (fileName.endsWith('update.bin') === entry.filename.endsWith('update.bin'))
          })
        if (file) {
          console.log('Found file:', file.filename);
          if (file?.getData) {
            const blob = await file.getData(new BlobWriter());
            const arrayBuffer = await blob.arrayBuffer();
            return convertToBinaryString(new Uint8Array(arrayBuffer));
          }
          throw new Error(`Could not find file with pattern ${fileName} in zip`);
        }
      } else if (this.selectedFile && !this.isZipFile) {
        const buffer = await this.selectedFile.arrayBuffer();
        return convertToBinaryString(new Uint8Array(buffer));
      }
      throw new Error('Cannot fetch binary content without a file or firmware selected');
    },
    async connectEsp32(transport: Transport, terminal: Terminal): Promise<ESPLoader> {
      const loaderOptions = <LoaderOptions>{
        transport,
        baudrate: this.baudRate,
        enableTracing: false,
        terminal: {
          clean() {
            terminal.clear();
          },
          writeLine(data) {
            terminal.writeln(data);
          },
          write(data) {
            terminal.write(data);
          }
        }
      };
      const espLoader = new ESPLoader(loaderOptions);
      const chip = await espLoader.main();
      console.log("Detected chip:", chip);
      return espLoader;
    },
    async readSerial(port: SerialPort, terminal: Terminal): Promise<void> {
      const decoder = new TextDecoderStream();
      if (port.readable) {
        port.readable.pipeTo(decoder.writable);
      } else {
        throw new Error('Serial port is not readable');
      }
      const inputStream = decoder.readable;
      const reader = inputStream.getReader();

      while (true) {
        const{ value } = await reader.read();
        if (value) {
          terminal.write(value);
        }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    },
  },
})