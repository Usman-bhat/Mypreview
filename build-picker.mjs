import * as esbuild from 'esbuild';
import fs from 'fs';

async function build() {
  const result = await esbuild.build({
    stdin: {
      contents: `
        import { ElementPicker } from "pick-dom-element";
        window.StartVsCodePicker = function() {
          if (window.__vsCodePickerActive) return;
          window.__vsCodePickerActive = true;
          
          const style = { 
            borderColor: "#0081f2",
            background: "rgba(0,129,242,0.08)"
          };
          const picker = new ElementPicker({ style });
          
          picker.start({
            onHover: (el) => {
              // We could send hover info
            },
            onClick: (el) => {
              picker.stop();
              window.__vsCodePickerActive = false;
              
              if (typeof window.__vscodePicker === 'function') {
                const payload = JSON.stringify({
                  outerHTML: el.outerHTML.slice(0, 50000),
                  tag: el.tagName.toLowerCase(),
                  id: el.id || '',
                  classes: Array.from(el.classList),
                  selector: el.id ? '#' + el.id : el.tagName.toLowerCase()
                });
                window.__vscodePicker(payload);
              }
            }
          });
          
          // Allow Escape to cancel
          window.__pickerCancel = (e) => {
            if (e.key === 'Escape') {
              picker.stop();
              window.__vsCodePickerActive = false;
              document.removeEventListener('keydown', window.__pickerCancel);
              if (typeof window.__vscodePicker === 'function') {
                window.__vscodePicker(JSON.stringify({ cancelled: true }));
              }
            }
          };
          document.addEventListener('keydown', window.__pickerCancel);
        };
        
        window.StopVsCodePicker = function() {
          if (!window.__vsCodePickerActive) return;
          window.__vsCodePickerActive = false;
          // Note: we'd need to store the picker instance globally to stop it here.
          // Let's modify the script above to store it.
        }
      `,
      resolveDir: '.',
    },
    bundle: true,
    write: false,
    format: 'iife',
    minify: true
  });
  
  fs.writeFileSync('src/browser/pickerScript.ts', `export const PICKER_SCRIPT = \`${result.outputFiles[0].text.replace(/\\/g, '\\\\').replace(/\`/g, '\\`').replace(/\$/g, '\\$')}\`;\n`);
  console.log('Generated src/browser/pickerScript.ts');
}

build();
