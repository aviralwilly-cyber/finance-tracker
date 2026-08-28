import { useEffect, useRef, useState, createElement, useMemo, useCallback } from 'react'
import './TextType.css'

// Typewriter effect. Adapted from the react-bits component, with one
// change: the original drives the cursor blink with GSAP, which isn't a
// dependency here and isn't worth adding for one opacity loop — a CSS
// keyframe animation does the same thing for free.
export default function TextType({
  text,
  as: Component = 'div',
  typingSpeed = 50,
  initialDelay = 0,
  pauseDuration = 2000,
  deletingSpeed = 30,
  loop = true,
  className = '',
  showCursor = true,
  hideCursorWhileTyping = false,
  cursorCharacter = '|',
  cursorClassName = '',
  textColors = [],
  variableSpeed,
  onSentenceComplete,
  startOnVisible = false,
  reverseMode = false,
  ...props
}) {
  const [displayedText, setDisplayedText] = useState('')
  const [currentCharIndex, setCurrentCharIndex] = useState(0)
  const [isDeleting, setIsDeleting] = useState(false)
  const [currentTextIndex, setCurrentTextIndex] = useState(0)
  const [isVisible, setIsVisible] = useState(!startOnVisible)
  const containerRef = useRef(null)

  const textArray = useMemo(() => (Array.isArray(text) ? text : [text]), [text])

  const getRandomSpeed = useCallback(() => {
    if (!variableSpeed) return typingSpeed
    const { min, max } = variableSpeed
    return Math.random() * (max - min) + min
  }, [variableSpeed, typingSpeed])

  const getCurrentTextColor = () => {
    if (textColors.length === 0) return 'inherit'
    return textColors[currentTextIndex % textColors.length]
  }

  // Reset when the text prop changes, so a new broadcast message types out
  // from the start rather than resuming mid-way through the old one.
  useEffect(() => {
    setDisplayedText('')
    setCurrentCharIndex(0)
    setIsDeleting(false)
    setCurrentTextIndex(0)
  }, [textArray.join('\u0000')])

  useEffect(() => {
    if (!startOnVisible || !containerRef.current) return
    const observer = new IntersectionObserver(
      entries => entries.forEach(e => e.isIntersecting && setIsVisible(true)),
      { threshold: 0.1 }
    )
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [startOnVisible])

  useEffect(() => {
    if (!isVisible) return
    if (textArray.length === 0) return

    let timeout
    const currentText = textArray[currentTextIndex] ?? ''
    const processedText = reverseMode ? currentText.split('').reverse().join('') : currentText

    const run = () => {
      if (isDeleting) {
        if (displayedText === '') {
          setIsDeleting(false)
          if (currentTextIndex === textArray.length - 1 && !loop) return
          if (onSentenceComplete) onSentenceComplete(textArray[currentTextIndex], currentTextIndex)
          setCurrentTextIndex(prev => (prev + 1) % textArray.length)
          setCurrentCharIndex(0)
        } else {
          timeout = setTimeout(() => setDisplayedText(prev => prev.slice(0, -1)), deletingSpeed)
        }
      } else if (currentCharIndex < processedText.length) {
        timeout = setTimeout(
          () => {
            setDisplayedText(prev => prev + processedText[currentCharIndex])
            setCurrentCharIndex(prev => prev + 1)
          },
          variableSpeed ? getRandomSpeed() : typingSpeed
        )
      } else if (textArray.length >= 1) {
        // Single message with loop off: type it once and leave it there.
        if (!loop && currentTextIndex === textArray.length - 1) return
        timeout = setTimeout(() => setIsDeleting(true), pauseDuration)
      }
    }

    if (currentCharIndex === 0 && !isDeleting && displayedText === '') {
      timeout = setTimeout(run, initialDelay)
    } else {
      run()
    }

    return () => clearTimeout(timeout)
  }, [
    currentCharIndex, displayedText, isDeleting, typingSpeed, deletingSpeed,
    pauseDuration, textArray, currentTextIndex, loop, initialDelay,
    isVisible, reverseMode, variableSpeed, onSentenceComplete, getRandomSpeed
  ])

  const shouldHideCursor =
    hideCursorWhileTyping &&
    (currentCharIndex < (textArray[currentTextIndex]?.length ?? 0) || isDeleting)

  return createElement(
    Component,
    { ref: containerRef, className: `text-type ${className}`, ...props },
    <span className="text-type__content" style={{ color: getCurrentTextColor() || 'inherit' }}>
      {displayedText}
    </span>,
    showCursor && (
      <span
        className={`text-type__cursor ${cursorClassName} ${shouldHideCursor ? 'text-type__cursor--hidden' : ''}`}
      >
        {cursorCharacter}
      </span>
    )
  )
}
