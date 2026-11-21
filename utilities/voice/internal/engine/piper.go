package engine

import "grigdesk.local/tools/utilities/voice/internal/local"

// piperModel принимает manifest с двумя проверенными файлами принятого голоса.
// Незнакомый путь не попадает в аргументы Python.
func piperModel(root, id, modelName, configName string, name, timbre *string) *installed {
	model := acceptedFile(root, modelName)
	config := acceptedFile(root, configName)
	if name == nil || timbre == nil || model == "" || config == "" {
		return nil
	}
	return &installed{
		model:    model,
		config:   config,
		speakers: []local.Speaker{{ID: id, Name: *name, Timbre: *timbre}},
	}
}
