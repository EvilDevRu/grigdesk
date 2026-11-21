package engine

import (
	"regexp"
	"slices"
	"strings"

	"grigdesk.local/tools/utilities/voice/internal/voicecore"
)

var unreadable = regexp.MustCompile(`(?i)[a-z0-9]+`)

// sileroText возвращает плюсы на позиции ударения и очищает внутренние символы Python.
// Вычисление использует те же позиции рун, что и канонический текст.
func sileroText(value voicecore.Prepared) string {
	var output strings.Builder
	for i, r := range value.Text {
		if slices.Contains(value.Stress, i) {
			output.WriteByte('+')
		}
		if r == '\ue000' || r == '\ue001' {
			r = ' '
		}
		output.WriteRune(r)
	}
	return output.String()
}
