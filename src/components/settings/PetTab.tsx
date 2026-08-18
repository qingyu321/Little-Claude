import { useCallback, useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useSettingsStore, loadPetSkins, addPetSkin } from '../../stores/settingsStore';
import { useT } from '../../lib/i18n';
import { bridge } from '../../lib/tauri-bridge';
import { hidePetWindow, showPetWindow } from '../../lib/pet/bridge';

/**
 * Settings tab for the desktop pet:
 * - Enable/disable toggle (auto-shows/hides the pet window)
 * - Pet skin selection + import (Codex pet bundles: pet.json + spritesheet.webp)
 * - Size slider (0.5–1.5, synced to the pet window via pet:status)
 * - Show/hide pet buttons
 */
export function PetTab() {
  const t = useT();
  const petEnabled = useSettingsStore((s) => s.petEnabled);
  const setPetEnabled = useSettingsStore((s) => s.setPetEnabled);
  const petScale = useSettingsStore((s) => s.petScale);
  const setPetScale = useSettingsStore((s) => s.setPetScale);
  const petSkin = useSettingsStore((s) => s.petSkin);
  const setPetSkin = useSettingsStore((s) => s.setPetSkin);
  const petNotify = useSettingsStore((s) => s.petNotify);
  const setPetNotify = useSettingsStore((s) => s.setPetNotify);

  const [skins, setSkins] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');

  const refreshSkins = useCallback(() => {
    // localStorage 注册表 ∪ 磁盘 bundle 目录（预置/手动放置的宠物包直接可用）
    void bridge.listImportedPets().then((disk) => {
      setSkins([...new Set([...loadPetSkins(), ...disk])]);
    });
  }, []);

  useEffect(() => {
    refreshSkins();
  }, [refreshSkins]);

  const handleImport = async () => {
    setImporting(true);
    setImportError('');
    try {
      // 1. Pick pet.json
      const jsonPath = await open({
        multiple: false,
        filters: [{ name: 'Pet config', extensions: ['json'] }],
      });
      if (!jsonPath || typeof jsonPath !== 'string') return;
      // B1: dialog-picked paths need backend authorization before the file
      // commands accept them.
      bridge.authorizeExternalPath(jsonPath).catch(() => {});
      const petJson = await bridge.readFileContent(jsonPath);

      // Validate minimal structure
      let parsed: { name?: string; frame?: unknown; states?: unknown };
      try {
        parsed = JSON.parse(petJson);
      } catch {
        setImportError(t('pet.importInvalidJson'));
        return;
      }
      if (!parsed.frame || !parsed.states) {
        setImportError(t('pet.importInvalidStructure'));
        return;
      }
      const petId = (parsed.name || 'pet').toLowerCase().replace(/[^a-z0-9-_]/g, '-') || 'pet';

      // 2. Pick spritesheet.webp (optional — procedural skins can skip it)
      const sheetPath = await open({
        multiple: false,
        filters: [{ name: 'Sprite sheet', extensions: ['webp', 'png'] }],
      });
      let spritesheetB64 = '';
      if (sheetPath && typeof sheetPath === 'string') {
        bridge.authorizeExternalPath(sheetPath).catch(() => {});
        spritesheetB64 = await bridge.readFileBase64(sheetPath);
      }

      await bridge.saveImportedPet(petId, petJson, spritesheetB64);
      addPetSkin(petId);
      setPetSkin(petId);
      refreshSkins();
      setImportError('');
    } catch (err) {
      setImportError(String(err));
    } finally {
      setImporting(false);
    }
  };

  const skinOptions = ['default', ...skins.filter((s) => s !== 'default')];

  return (
    <div className="space-y-6">
      {/* ===== Title ===== */}
      <div>
        <h3 className="text-[15px] font-medium text-text-primary">
          {t('settings.tab.pet')}
        </h3>
        <p className="mt-1.5 text-[12px] text-text-tertiary leading-relaxed max-w-xl">
          {t('pet.enabledHint')}
        </p>
      </div>

      {/* ===== Enable toggle ===== */}
      <div className="rounded-xl border border-border-subtle bg-bg-secondary/30 p-4 max-w-xl">
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <span className="text-[13px] font-medium text-text-primary">
              {t('pet.enabled')}
            </span>
            <p className="mt-0.5 text-[11px] text-text-tertiary">
              {t('pet.enabledHint')}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={petEnabled}
            onClick={() => setPetEnabled(!petEnabled)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full
              transition-smooth flex-shrink-0 ml-3 ${
                petEnabled ? 'bg-accent' : 'bg-bg-tertiary'
              }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm
                transition-smooth ${petEnabled ? 'translate-x-4.5' : 'translate-x-0.5'}`}
            />
          </button>
        </label>
      </div>

      {/* ===== Completion notification toggle ===== */}
      <div className="rounded-xl border border-border-subtle bg-bg-secondary/30 p-4 max-w-xl">
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <span className="text-[13px] font-medium text-text-primary">
              {t('pet.notify')}
            </span>
            <p className="mt-0.5 text-[11px] text-text-tertiary">
              {t('pet.notifyHint')}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={petNotify}
            onClick={() => setPetNotify(!petNotify)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full
              transition-smooth flex-shrink-0 ml-3 ${
                petNotify ? 'bg-accent' : 'bg-bg-tertiary'
              }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm
                transition-smooth ${petNotify ? 'translate-x-4.5' : 'translate-x-0.5'}`}
            />
          </button>
        </label>
      </div>

      {/* ===== Pet skin selection + import ===== */}
      <div className="rounded-xl border border-border-subtle bg-bg-secondary/30 p-4 max-w-xl">
        <div className="text-[13px] font-medium text-text-primary mb-2">
          {t('pet.skin')}
        </div>
        <div className="flex items-center gap-2 mb-3">
          <select
            value={petSkin}
            onChange={(e) => setPetSkin(e.target.value)}
            className="flex-1 h-8 rounded-lg bg-bg-primary border border-border-subtle
              px-2 text-[12px] text-text-primary outline-none focus:border-border-focus"
          >
            {skinOptions.map((id) => (
              <option key={id} value={id}>
                {id === 'default' ? t('pet.skinDefault') : id}
              </option>
            ))}
          </select>
          <button
            onClick={() => void handleImport()}
            disabled={importing}
            className="py-1.5 px-3 rounded-lg text-[12px] font-medium transition-smooth
              bg-accent hover:bg-accent-hover text-text-inverse disabled:opacity-50"
          >
            {importing ? '…' : t('pet.import')}
          </button>
        </div>
        {importError && (
          <p className="text-[11px] text-error mt-1">{importError}</p>
        )}
        <p className="text-[11px] text-text-tertiary leading-relaxed">
          {t('pet.importHint')}
        </p>
      </div>

      {/* ===== Size slider ===== */}
      <div className="rounded-xl border border-border-subtle bg-bg-secondary/30 p-4 max-w-xl">
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-text-muted w-16">
            {t('pet.scale')}
          </span>
          <input
            type="range"
            min="0.25"
            max="3"
            step="0.05"
            value={petScale}
            onChange={(e) => setPetScale(Number(e.target.value))}
            className="flex-1 h-1.5 rounded-full appearance-none bg-bg-tertiary
              accent-accent cursor-pointer
              [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5
              [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full
              [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:shadow-sm"
          />
          <span className="text-[12px] text-text-secondary w-14 text-right tabular-nums">
            {Math.round(petScale * 100)}%
          </span>
        </div>
        {/* Preset quick buttons — snap to common sizes */}
        <div className="mt-3 flex items-center gap-1.5 flex-wrap">
          {[
            { label: '迷你', v: 0.35 },
            { label: '小', v: 0.6 },
            { label: '中', v: 1 },
            { label: '大', v: 1.6 },
            { label: '超大', v: 2.4 },
            { label: '巨兽', v: 3 },
          ].map(({ label, v }) => (
            <button
              key={label}
              onClick={() => setPetScale(v)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-smooth border
                ${Math.abs(petScale - v) < 0.03
                  ? 'bg-accent text-text-inverse border-accent'
                  : 'border-border-subtle text-text-muted hover:bg-bg-secondary hover:text-text-primary'}`}
            >
              {label} {Math.round(v * 100)}%
            </button>
          ))}
        </div>
      </div>

      {/* ===== Show / hide buttons ===== */}
      <div className="flex items-center gap-2 max-w-xl">
        <button
          onClick={() => void showPetWindow()}
          className="py-1.5 px-3.5 rounded-lg text-[12px] font-medium transition-smooth
            bg-accent hover:bg-accent-hover text-text-inverse"
        >
          {t('pet.showNow')}
        </button>
        <button
          onClick={() => void hidePetWindow()}
          className="py-1.5 px-3.5 rounded-lg text-[12px] font-medium transition-smooth
            border border-border-subtle text-text-muted hover:bg-bg-secondary hover:text-text-primary"
        >
          {t('pet.hideNow')}
        </button>
      </div>
    </div>
  );
}
